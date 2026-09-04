/**
 * Phase 2 collector: fetch every verified source, extract its readable text,
 * work out whether it changed, and record what happened to every one of them.
 *
 * The rule that shapes this file is spec section 0.3, fail loudly not silently.
 * A source that could not be fetched, or that robots.txt put out of reach, is
 * written into health.json as degraded or broken. It is never quietly dropped
 * to keep the dashboard green, because a stale green light is worse than a red
 * one for someone whose semester depends on catching a 7-day window.
 *
 * Only sources carrying `verifiedAtISO` are fetched. An unopened lead has not
 * been confirmed to be the page it claims to be, and the pipeline must not
 * spend requests, or the user's trust, on a guess.
 *
 * Usage:
 *   npm run collect                  every verified source
 *   npm run collect -- --limit 5     the acceptance run for this phase
 *   npm run collect -- --dry-run     fetch and report, write nothing
 *   npm run collect -- --verbose     one line per source
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import pLimit from "p-limit";
import { HAS_CONTACT, USER_AGENT } from "../src/pipeline/agent";
import { browserUnavailable, closeBrowser, renderPage } from "../src/pipeline/browser";
import {
  CLASSIFIER_MODEL,
  addUsage,
  classify,
  costOf,
  notCopiedFrom,
  studentProfile,
  triage,
  type Classification,
  type Usage,
} from "../src/pipeline/classify";
import { localModelReady } from "../src/pipeline/model";
import { readProfile } from "../src/pipeline/relevance";
import {
  asManualReview,
  fromClassification,
  humanReason,
  markVanished,
  survivingRecord,
  UNJUDGED_TITLE,
} from "../src/pipeline/opportunity";
import { extract, isGovBannerOnly, isSoft404, sha256 } from "../src/pipeline/extract";
import { redactPaths } from "../src/pipeline/redact";
import { fetchPage, paced } from "../src/pipeline/fetch";
import { checkFinalUrl, checkRobots } from "../src/pipeline/robots";
import { MAX_BROWSER_SOURCES, SILENT_THIN_RUNS, THIN_CHARS, statusFor } from "../src/types";
import type {
  AggregatorSource,
  HealthState,
  Opportunity,
  Organisation,
  RenderMode,
  SourceHealth,
  SourceSnapshot,
} from "../src/types";
import { loadEnvFile } from "../src/pipeline/env";

/* Secrets live in a gitignored .env on this machine. Read before anything
 * asks process.env for one: a scheduled task starts with a bare environment,
 * and a missing subscription makes the notifier skip silently. */
loadEnvFile();

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const DRY_RUN = has("--dry-run");
const VERBOSE = has("--verbose");
const limitArg = args.indexOf("--limit");
/**
 * `--limit` with a missing or malformed number used to erase the dataset.
 *
 * `Number(undefined)` is NaN. `slice(0, NaN)` returns an empty array, so no
 * source was read; and `Number.isFinite(NaN)` is false, so `wholeRun` below
 * came out *true* and the pruning branch deleted every health and snapshot row
 * whose url was not in the (empty) set of sources read this round. One typo
 * threw away 422 fingerprints and every `firstSeenISO` in the file.
 *
 * There is no safe default here. A limit the caller cannot state is a limit we
 * must not guess, so this refuses to run rather than run over nothing.
 */
const LIMIT = ((): number => {
  if (limitArg < 0) return Infinity;
  const raw = args[limitArg + 1];
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < 1) {
    console.error(
      `--limit needs a positive whole number, and got ${raw === undefined ? "nothing" : JSON.stringify(raw)}.`,
    );
    process.exit(2);
  }
  return n;
})();
const onlyArg = args.indexOf("--only");
/** Debug one source without hitting every host again. */
const ONLY = onlyArg >= 0 ? args[onlyArg + 1] : null;

/**
 * One collector at a time, because two of them destroy each other's round.
 *
 * Every file this script produces is written at the very end, in one block. So
 * two collectors do not interleave, they overwrite: whichever finishes second
 * writes `health.json`, `snapshots.json` and `opportunities.json` from the state
 * it read at *its* start, and the other round's work is gone with no error
 * anywhere. The watcher has a single-instance guard of its own, and it does not
 * help — the second collector is usually one somebody started by hand.
 *
 * It happened during this project's own repair session: a background round was
 * "stopped", the shell died and the node process did not, and a second round was
 * started on top of it. Two collectors, forty-five sources each, both about to
 * write the whole dataset. Nothing in the code would have said a word.
 *
 * A pid file, checked for liveness rather than trusted. A stale lock from a
 * machine that lost power must not block collection for ever, so a lock whose
 * process is gone is taken over and said so.
 */
const LOCK_FILE = ".rasid/collect.lock";
{
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (!DRY_RUN) {
    mkdirSync(".rasid", { recursive: true });
    if (existsSync(LOCK_FILE)) {
      const held = Number(readFileSync(LOCK_FILE, "utf8").trim());
      if (Number.isInteger(held) && held !== process.pid && alive(held)) {
        console.error(
          `another collector is already running (pid ${held}), and two of them overwrite` +
            ` each other's whole round. This one is stopping instead.`,
        );
        process.exit(3);
      }
      if (Number.isInteger(held)) {
        console.log(`taking over a lock left by pid ${held}, which is no longer running`);
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid), "utf8");
    /*
     * Released on the way out, however that happens. A SIGKILL cannot be caught
     * and will leave the file behind, which is exactly what the liveness check
     * above is for.
     */
    const release = (): void => {
      try {
        if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) {
          rmSync(LOCK_FILE);
        }
      } catch {
        // A lock we cannot remove is a lock the next run will take over.
      }
    };
    process.on("exit", release);
    process.on("SIGINT", () => {
      release();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      release();
      process.exit(143);
    });
  }
}


/**
 * A wall-clock deadline for the whole round, so the round can always reach its
 * own write.
 *
 * Every file this script produces is written at the very end, in one block. So
 * a round that is killed part-way through has not saved half its work: it has
 * saved none of it. That made the watcher's kill timer and this script's budget
 * a single mechanism pretending to be two, and they disagreed — the watcher
 * stopped the child after twelve minutes while this script's own ceiling was
 * fifteen minutes *of inference alone*, before any fetching was counted. The
 * child was therefore killed on any long round, every page it had read was
 * discarded, and the watcher then marked all forty sources as checked.
 *
 * The deadline is set by whoever owns the kill timer and is passed in, rather
 * than guessed here, because only the caller knows how long it is willing to
 * wait. A run started by hand has no deadline at all: nothing is going to kill
 * it, so stopping early would only lose work.
 */
const runStartedAt = Date.now();
/*
 * A hand-run round used to default to `Infinity`, and the reasoning was that
 * nothing is going to kill it so stopping early would only lose work.
 *
 * That is exactly backwards for the failure it meets. This script writes every
 * file it produces at the very end, in one block, so a round that never reaches
 * the end writes *nothing*. "No deadline" therefore does not preserve the work,
 * it guarantees losing all of it the first time a fetch wedges.
 *
 * And it wedged, during this project's own repair session: a forty-five source
 * round sat for fifteen minutes with zero CPU, no open sockets and no browser -
 * every promise awaited, none of them ever going to settle. It would have sat
 * there until the machine was restarted.
 *
 * Forty-five minutes is far longer than a full sweep needs and short enough that
 * a wedged round still ends its day by writing what it read.
 */
const DEFAULT_RUN_DEADLINE_MS = 45 * 60_000;
const RUN_DEADLINE_MS = Number(process.env.RASID_RUN_DEADLINE_MS ?? DEFAULT_RUN_DEADLINE_MS);
let ranOutOfTime = 0;
const outOfTime = (): boolean => Date.now() - runStartedAt >= RUN_DEADLINE_MS;

/**
 * Read only the sources named in a file, one url per line.
 *
 * This is how the resident watcher drives a round. It decides which sources are
 * due on their own intervals and hands the list over, rather than this script
 * sweeping everything four times a day.
 *
 * A round over a subset must not prune: `wholeRun` below is already false
 * whenever a filter is in play, so health and snapshot records for sources that
 * were simply not due this cycle are carried forward untouched. Getting that
 * wrong would delete most of the dataset every fifteen minutes.
 */
const urlsArg = args.indexOf("--urls");
const URL_LIST: Set<string> | null =
  urlsArg >= 0
    ? new Set(
        readFileSync(args[urlsArg + 1]!, "utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      )
    : null;

// A BOM is stripped because Windows editors and PowerShell add one silently,
// and JSON.parse rejects it with an error that points at nothing useful.
const read = <T>(p: string): T[] =>
  JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];
const orgs = read<Organisation>("data/organisations.json");
const aggregators = read<AggregatorSource>("data/aggregators.json");
const priorHealth = read<SourceHealth>("data/health.json");
const priorSnapshots = read<SourceSnapshot>("data/snapshots.json");
const priorOpportunities = read<Opportunity>("data/opportunities.json");

/** Skip the model entirely, for a network-only run. */
const NO_CLASSIFY = has("--no-classify");
/**
 * Classify everything fetched, not just what moved. For the first run after
 * the classifier lands, and for any run after the system prompt changes -
 * old verdicts were produced by a prompt that no longer exists.
 */
const RECLASSIFY = has("--reclassify");

interface Target {
  ownerId: string;
  url: string;
  label: string;
  renderMode: RenderMode;
  browserRetryInCI: boolean;
}

/** GitHub Actions sets CI=true. A runner has more memory than a laptop. */
const IS_CI = Boolean(process.env.CI);

/* Verified sources only. `verifiedAtISO === null` means nobody opened it. */
const targets: Target[] = [
  ...orgs.flatMap((o) =>
    o.sources
      .filter((s) => s.verifiedAtISO !== null)
      .map((s) => ({
        ownerId: o.id,
        url: s.url,
        label: o.nameAr,
        renderMode: s.renderMode,
        browserRetryInCI: s.browserRetryInCI === true,
      })),
  ),
  ...aggregators.flatMap((a) =>
    a.link !== null && a.link.verifiedAtISO !== null
      ? [
          {
            ownerId: a.id,
            url: a.link.url,
            label: a.nameAr,
            renderMode: "static" as const,
            browserRetryInCI: false,
          },
        ]
      : [],
  ),
]
  .filter((t) => ONLY === null || t.ownerId === ONLY)
  .filter((t) => URL_LIST === null || URL_LIST.has(t.url))
  .slice(0, LIMIT);

const staticTargets = targets.filter((t) => t.renderMode === "static");
const allBrowserTargets = targets.filter((t) => t.renderMode === "browser");

/*
 * Over the cap is a degradation, not a death.
 *
 * This used to exit(1), which killed the entire run: no collection, no
 * notification, no deploy, because too many pages had turned out to be
 * javascript-only. That is a whole day of blindness as the punishment for the
 * source list growing, and growth is the goal. The cap still means something —
 * it is what keeps the browser a decision rather than a default — but the
 * sources beyond it are simply not read this run and say so in health.json,
 * where the app shows them as unwatched. Loud and partial beats silent and
 * total.
 */
const browserTargets = allBrowserTargets.slice(0, MAX_BROWSER_SOURCES);
const overflow = allBrowserTargets.slice(MAX_BROWSER_SOURCES);

if (overflow.length > 0) {
  console.log(
    `\n${allBrowserTargets.length} sources ask for the browser and the cap is ${MAX_BROWSER_SOURCES}.\n` +
      `Reading ${browserTargets.length}; ${overflow.length} are left unread this run and marked as such.`,
  );
}

const now = new Date().toISOString();

/*
 * Records for sources that no longer exist are dropped.
 *
 * A source can leave the dataset — a duplicate merged away, a link that turned
 * out to be the wrong page. Its snapshot and its health record used to stay
 * behind for ever, and a health record is what the interface counts as "a
 * source being watched": the app would keep reporting a page nobody fetches any
 * more. The validator caught one and called it what it is, unwatchable.
 *
 * Only run when the whole set is being collected: with --org or --limit the
 * targets are a slice, and pruning against a slice would delete the rest.
 */
/*
 * An empty target list can never authorise forgetting anything.
 *
 * Pruning is meant to follow a deliberate edit to organisations.json. It must
 * not follow a *failure to read* organisations.json, a filter that matched
 * nothing, or any other path that leaves `targets` empty: there the set of
 * "sources still in the dataset" is empty for the wrong reason, and every
 * health and snapshot row in the file matches the delete condition at once.
 */
const wholeRun =
  ONLY === null && URL_LIST === null && !Number.isFinite(LIMIT) && targets.length > 0;
const live = new Set(targets.map((t) => t.url));
const keep = <T extends { sourceUrl: string }>(rows: T[]): T[] =>
  wholeRun ? rows.filter((r) => live.has(r.sourceUrl)) : rows;

const forgotten = wholeRun
  ? [...priorHealth, ...priorSnapshots].filter((r) => !live.has(r.sourceUrl)).map((r) => r.sourceUrl)
  : [];
if (forgotten.length > 0) {
  console.log(`forgetting ${forgotten.length} record(s) for sources no longer in the dataset`);
  // Named, not counted: a count cannot be checked against the edit that caused it.
  for (const url of [...new Set(forgotten)].slice(0, 20)) console.log(`  ${url}`);
}

const healthByUrl = new Map(keep(priorHealth).map((h) => [h.sourceUrl, h]));
const snapshotByUrl = new Map(keep(priorSnapshots).map((s) => [s.sourceUrl, s]));

/** Any failure is degraded. See the note on SourceHealth.state for why. */
const stateFor = (failures: number): HealthState =>
  failures > 5 ? "broken" : failures >= 1 ? "degraded" : "healthy";

type Outcome = "changed" | "unchanged" | "robots_skip" | "unreadable" | "failed";
const tally: Record<Outcome, number> = {
  changed: 0,
  unchanged: 0,
  robots_skip: 0,
  unreadable: 0,
  failed: 0,
};
const lines: string[] = [];

/**
 * Below this, the fetch technically succeeded but produced nothing to watch.
 * Several Saudi portals ship an empty shell and paint the page with
 * JavaScript, which this crawler does not run. Recording such a source as
 * healthy would be the stale green light spec section 0.3 forbids: the
 * pipeline would sit on it for months and never see the announcement.
 */
const MIN_USABLE_CHARS = 50;

/** Sources that failed this run, so the CI retry knows what to attempt. */
const failedUrls = new Set<string>();

/** Extracted text of everything fetched successfully, for the classifier. */
const textByUrl = new Map<string, string>();

/**
 * Block hashes as fetched this round, held until a verdict is reached.
 *
 * See the note where these are set: promoting them to the snapshot before
 * anything judged the page is what let an announcement be diffed away unread.
 */
const freshBlockHashes = new Map<string, string[]>();


function recordFailure(t: Target, error: string, outcome: Outcome): void {
  const prev = healthByUrl.get(t.url);
  const failures = (prev?.consecutiveFailures ?? 0) + 1;
  healthByUrl.set(t.url, {
    sourceUrl: t.url,
    orgId: t.ownerId,
    lastAttemptISO: now,
    lastSuccessISO: prev?.lastSuccessISO ?? null,
    consecutiveFailures: failures,
    lastError: redactPaths(error),
    state: stateFor(failures),
  });
  failedUrls.add(t.url);
  tally[outcome]++;
  const tag = outcome === "robots_skip" ? "SKIP" : outcome === "unreadable" ? "BLNK" : "FAIL";
  lines.push(`  ${tag}  ${t.ownerId.padEnd(14)} ${error}`);
}

async function collect(t: Target): Promise<void> {
  /*
   * Stopping here leaves the source exactly as it was: no health row is
   * touched, so it stays due and is read first next cycle. That is the
   * opposite of being killed, which discards the whole round's reading.
   */
  if (outOfTime()) {
    ranOutOfTime++;
    return;
  }
  const verdict = await checkRobots(t.url);
  if (!verdict.allowed) {
    // A robots skip is not an error on our side, but it does mean this source
    // is unwatched, and the user must see that in the header status line.
    recordFailure(t, `robots.txt: ${verdict.reason}`, "robots_skip");
    return;
  }

  // The browser path is paced by the same per-host rules as the plain fetcher.
  const res =
    t.renderMode === "browser"
      ? await paced(t.url, verdict.crawlDelayMs, () => renderPage(t.url))
      : await fetchPage(t.url, verdict.crawlDelayMs);
  if (!res.ok) {
    recordFailure(t, res.error, "failed");
    return;
  }

  // Permission was asked of the host we requested. A redirect can hand us a
  // different one, and that host has not agreed to anything.
  const afterRedirect = await checkFinalUrl(t.url, res.finalUrl);
  if (afterRedirect) {
    recordFailure(t, `robots.txt: ${afterRedirect.reason}`, "robots_skip");
    return;
  }

  const extracted = extract(res.html, t.url);
  const { hash, chars, method } = extracted;

  // A page that answers 200 while saying it is missing is a failure, whatever
  // the transport thought. Recorded as one, so it cannot sit green for ever.
  if (isSoft404(extracted.title)) {
    recordFailure(t, `الصفحة تردّ 200 وعنوانها «${extracted.title}»، أي أنها صفحة غير موجودة`, "failed");
    return;
  }

  /*
   * The verification banner is not the page, and must never be judged as one.
   *
   * It is real Arabic prose, so it is not empty and not a soft 404, and it sailed
   * through every check here. Thirty records were built from it and six were
   * scored as genuine announcements. Recorded as unreadable, which is what it is:
   * the page exists, we were shown the doormat.
   */
  if (isGovBannerOnly(extracted.text)) {
    recordFailure(
      t,
      "لم تُقرأ الصفحة نفسها، وإنما لافتة التحقّق الحكومية وحدها. تحتاج متصفّحاً كاملاً أو أنها تُحجب.",
      "unreadable",
    );
    return;
  }
  if (chars < MIN_USABLE_CHARS) {
    /*
     * Keep the record, clear the hash.
     *
     * Deleting it took `firstSeenISO` and `lastChangedISO` with it — the two
     * dates types.ts calls the honest basis for predicting a window — and the
     * next successful run then wrote `lastChangedISO: now`, asserting a change
     * that never happened. One maintenance banner or one geo-blocked fetch was
     * enough, and the two collectors disagree about these hosts every six
     * hours, so it happened routinely. A null hash says "we cannot see this
     * page right now" without also erasing what we saw before.
     */
    const kept = snapshotByUrl.get(t.url);
    if (kept) snapshotByUrl.set(t.url, { ...kept, contentHash: null });
    recordFailure(
      t,
      `fetched ${res.bytes} bytes but extracted only ${chars} chars of text; the page is probably rendered by javascript and cannot be watched this way`,
      "unreadable",
    );
    return;
  }

  const prevSnapshot = snapshotByUrl.get(t.url);
  const changed = prevSnapshot?.contentHash !== hash;

  /*
   * Spec 5.3: send the classifier the block that changed, not the top of the
   * page. On a long portal the announcement is rarely in the first 6000
   * characters, so slicing the head meant the model was asked about the
   * navigation and answered, correctly, that it saw no announcement.
   *
   * On first sight there is nothing to diff against and the whole text is the
   * change. The page title and its opening line ride along with the changed
   * blocks, because a bare paragraph with no idea whose page it is on is a
   * worse question than a slightly longer one.
   */
  const priorBlocks = new Set(prevSnapshot?.blockHashes ?? []);
  const blockHashes = extracted.blocks.map((b) => sha256(b).slice(0, 16));
  const newBlocks =
    priorBlocks.size === 0
      ? extracted.blocks
      : extracted.blocks.filter((_, i) => !priorBlocks.has(blockHashes[i]!));

  const payload =
    priorBlocks.size === 0 || newBlocks.length === 0
      ? extracted.text
      : [extracted.title ?? "", extracted.blocks[0] ?? "", ...newBlocks]
          .filter(Boolean)
          .join("\n\n");

  // A thin page that also stops moving is the signature of a page we are not
  // really reading. Counted here, escalated by the validator at ten.
  const thinAndSilent = chars < THIN_CHARS && !changed;

  // Kept so the classification pass can read what was fetched without a
  // second request. Only successful, usable extractions land here.
  textByUrl.set(t.url, payload);

  /*
   * The diff base is "the text as it stood when a verdict was last reached",
   * not "the text as it stood when we last fetched". Those came apart in the
   * rounds that fetch without judging — the ones that run while a game is on.
   *
   * There, the announcement's own block was fetched, hashed, and written into
   * the base; nothing judged it. If the page then moved again before the next
   * judging round, that block was no longer new, so it was cut out of the
   * excerpt the model is shown, and the model was asked about the rotating
   * banner instead. It answered, correctly, that a banner is not an
   * announcement, and the round then cleared the debt. The announcement sat on
   * the page, unread, and nothing anywhere recorded that it had been skipped.
   *
   * So the fresh hashes are held aside here and only become the base once this
   * page actually reaches a verdict.
   */
  freshBlockHashes.set(t.url, blockHashes);

  snapshotByUrl.set(t.url, {
    sourceUrl: t.url,
    orgId: t.ownerId,
    contentHash: hash,
    blockHashes: prevSnapshot?.blockHashes ?? [],
    extractedChars: chars,
    extractionMethod: method,
    firstSeenISO: prevSnapshot?.firstSeenISO ?? now,
    lastChangedISO: changed ? now : (prevSnapshot?.lastChangedISO ?? null),
    thinRuns: thinAndSilent ? (prevSnapshot?.thinRuns ?? 0) + 1 : 0,
    // New text owes a verdict. Unchanged text keeps whatever it was owed, so
    // a source whose classification failed last run is retried, not buried.
    pendingClassification: changed ? true : (prevSnapshot?.pendingClassification ?? false),
  });
  healthByUrl.set(t.url, {
    sourceUrl: t.url,
    orgId: t.ownerId,
    lastAttemptISO: now,
    lastSuccessISO: now,
    consecutiveFailures: 0,
    lastError: null,
    state: "healthy",
  });

  tally[changed ? "changed" : "unchanged"]++;
  lines.push(
    `  ${changed ? "NEW " : "same"}  ${t.ownerId.padEnd(14)} ${String(chars).padStart(6)} chars  ${method === "readability" ? "readability" : "body-fallback"}`,
  );
}

console.log(`RASID collector${DRY_RUN ? " (dry run, nothing will be written)" : ""}`);
console.log(
  `${targets.length} verified source(s), ${browserTargets.length} of them rendered\n${USER_AGENT}\n`,
);
if (!HAS_CONTACT) {
  console.log("note: RASID_CONTACT is unset, so requests carry no contact address.\n");
}

/*
 * Asked once, at the top, so a missing model is one line rather than a hundred
 * identical failures buried in the classification pass.
 *
 * It does not stop the run. Fetching is still worth doing with no model at all:
 * the hashes are stored, so when the model comes back only what actually
 * changed is judged. What must not happen is the run looking healthy while
 * nothing is being judged, which is why this prints either way.
 */
const modelReady = await localModelReady();
console.log(modelReady.ok ? `model: ${modelReady.reason}\n` : `MODEL UNAVAILABLE: ${modelReady.reason}\nPages will be fetched and hashed; nothing will be judged.\n`);

/*
 * robots.txt first, one fetch per origin — but not one at a time.
 *
 * This was a plain sequential loop, written when there were eighteen sources on
 * a handful of hosts. At 141 origins it became the reason the whole run died: a
 * host that does not answer costs three attempts at twenty seconds, plus
 * backoff, plus a headless-browser attempt, and a dozen such hosts exhaust a
 * twenty-five minute budget before a single page has been fetched. A scheduled
 * run timed out having collected nothing, and reported success.
 *
 * They are still one request per origin, still cached, and still paced per host
 * by `fetchPage` — only the waiting is shared now. Six at a time is well under
 * what any single host sees, because these are all different hosts.
 */
const origins = [...new Set(targets.map((t) => new URL(t.url).origin))];
const robotsAtOnce = pLimit(6);
console.log(`reading robots.txt for ${origins.length} host(s)…`);
await Promise.all(origins.map((origin) => robotsAtOnce(() => checkRobots(origin))));

/**
 * Run a phase, and give up on it at the round's deadline rather than never.
 *
 * `fetchPage` has its own per-request timeout and `paced` serialises per host,
 * so in principle nothing here can hang. In practice a round did: fifteen
 * minutes at zero CPU with no sockets open, which is what a promise that will
 * never settle looks like from outside. Whatever the cause, the round must
 * still reach its own write - the sources it did read are worth keeping, and
 * the ones it did not simply have no entry this round, which is the correct
 * "not read" state and is exactly what the health file is for.
 */
async function withinDeadline(work: Promise<unknown>, label: string): Promise<void> {
  const left = RUN_DEADLINE_MS - (Date.now() - runStartedAt);
  if (!Number.isFinite(left)) {
    await work;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), Math.max(0, left));
  });
  const winner = await Promise.race([work.then(() => "done" as const), deadline]);
  if (timer !== undefined) clearTimeout(timer);
  if (winner === "deadline") {
    ranOutOfTime++;
    console.log(
      `
${label} did not finish inside the round's deadline. Writing what was read;` +
        " the rest keep their previous state and stay due.",
    );
  }
}

// Every source is awaited, and a rejection here would be a bug in this file
// rather than a bad page: collect() converts page failures into health records.
await withinDeadline(
  Promise.all(staticTargets.map((t) => collect(t))),
  `the ${staticTargets.length} static source(s)`,
);

// Rendered sources run strictly one at a time, after the cheap work is done.
await withinDeadline(
  (async () => {
    for (const t of browserTargets) {
      if (outOfTime()) break;
      await collect(t);
    }
  })(),
  `the ${browserTargets.length} rendered source(s)`,
);

// What the cap left out is recorded as unread, with the reason, so the app can
// show it. A source nobody looked at must never sit in the dataset as healthy.
for (const t of overflow) {
  recordFailure(
    t,
    `not read this run: ${allBrowserTargets.length} sources need a real browser and the cap is ${MAX_BROWSER_SOURCES}`,
    "failed",
  );
}

/*
 * The CI-only second chance.
 *
 * A source marked browserRetryInCI failed to render on the machine that set
 * the flag, for want of memory rather than for anything the site did. A runner
 * container is roomier, so try once more there. A success is not a one-off: it
 * promotes the source to "browser" for good, and writes down why, so the next
 * reader of organisations.json can see it was earned rather than assumed.
 */
const promotions: string[] = [];
if (IS_CI) {
  const retryable = staticTargets.filter((t) => t.browserRetryInCI && failedUrls.has(t.url));
  let seatsLeft = MAX_BROWSER_SOURCES - browserTargets.length;

  for (const t of retryable) {
    if (seatsLeft <= 0) {
      lines.push(`  CAP   ${t.ownerId.padEnd(14)} browser seats are full, retry skipped`);
      continue;
    }
    const verdict = await checkRobots(t.url);
    if (!verdict.allowed) continue; // already recorded by the static pass

    const res = await paced(t.url, verdict.crawlDelayMs, () => renderPage(t.url));
    if (!res.ok) continue; // the static failure already stands in health.json

    const { hash, chars, method, text } = extract(res.html, t.url);
    if (chars < MIN_USABLE_CHARS) continue;

    textByUrl.set(t.url, text);
    snapshotByUrl.set(t.url, {
      sourceUrl: t.url,
      orgId: t.ownerId,
      contentHash: hash,
      extractedChars: chars,
      extractionMethod: method,
      firstSeenISO: snapshotByUrl.get(t.url)?.firstSeenISO ?? now,
      lastChangedISO: now,
      thinRuns: 0,
      pendingClassification: true,
    });
    healthByUrl.set(t.url, {
      sourceUrl: t.url,
      orgId: t.ownerId,
      lastAttemptISO: now,
      lastSuccessISO: now,
      consecutiveFailures: 0,
      lastError: null,
      state: "healthy",
    });

    const source = orgs.find((o) => o.id === t.ownerId)?.sources.find((s) => s.url === t.url);
    if (source) {
      source.renderMode = "browser";
      delete source.browserRetryInCI;
      source.renderModeNote = `promoted to browser on ${now}: static extraction failed on this page, rendering in CI returned ${chars} chars`;
    }
    seatsLeft--;
    tally.changed++;
    promotions.push(`  ${t.ownerId.padEnd(14)} static -> browser, ${chars} chars`);
  }
}

await closeBrowser();

/*
 * Classification.
 *
 * Only text that is owed a verdict is sent: what changed this run, plus what a
 * previous run failed to judge. Everything else costs nothing, which is the
 * whole reason the hashes exist.
 */
const opportunityById = new Map(priorOpportunities.map((o) => [o.id, o]));
const orgsWithHistory = new Set(priorOpportunities.map((o) => o.orgId));
const spend: Usage = { inputTokens: 0, outputTokens: 0 };
const reviewQueue: string[] = [];
/** Records whose page stopped showing them this run. Never silent. */
const vanished: string[] = [];
let classified = 0;
let notAnnouncements = 0;
/** Pages whose changed text did not mention training at all. Never silent. */
let skippedByFilter = 0;
/** Remembered verdicts thrown out because their wording is not on the page. */
let poisonedVerdicts = 0;
/** Pages answered from a verdict already paid for. */
let fromMemory = 0;
/** Pages the one-word question ruled out before the expensive one. */
let triagedOut = 0;

/**
 * Verdicts already paid for, keyed by the text that produced them.
 *
 * `null` means "asked, and it is not an announcement" — worth remembering
 * precisely because that is the answer nineteen pages in twenty give, and the
 * one there is no point buying twice.
 */
const VERDICTS_FILE = "data/verdicts.json";

/**
 * The verdict memory, stamped with the model that filled it.
 *
 * It was a bare map of fingerprint to verdict, and that made it a cache with no
 * way to go stale. When the classifier moved from llama3.1 to qwen3:8b - because
 * llama3.1 could not write Arabic, which is the root cause the audit spent its
 * whole length looking for - every answer that model had already given stayed in
 * this file and went on being replayed. `collect` looks the fingerprint up,
 * finds a hit, and hands the old verdict straight to `fromClassification`, which
 * never sees the copied-wording guard because that guard lives inside
 * `classify()`.
 *
 * The damage is visible in the data. Twenty-two of ninety-four remembered
 * verdicts carry a title in Arabic letters that is not Arabic words: `hrsd` is
 * stored as a run of non-words over a page whose extracted text reads perfectly.
 * Their dates are the same quality - "06 اوعأبت 2023", "06-ميع 2026" - which is
 * a large part of why the dataset holds three dates across every record it has.
 *
 * And nothing could ever clear them: the page has not changed, so the
 * fingerprint still matches, so the poisoned answer is returned again. A cache
 * that cannot be invalidated by the thing that produced it is not a cache, it is
 * a permanent record of one model's worst day.
 *
 * A stamp fixes both halves. A file written by a different model is not read at
 * all, so changing the model re-judges everything at local-CPU cost and nothing
 * else; and a file with no stamp is from before this existed, which is exactly
 * the era being thrown away.
 */
interface VerdictFile {
  model: string;
  writtenISO: string;
  verdicts: Record<string, Classification | null>;
}

const verdicts = ((): Map<string, Classification | null> => {
  if (!existsSync(VERDICTS_FILE)) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(VERDICTS_FILE, "utf8").replace(/^﻿/, ""));
  } catch {
    console.log("verdict memory: unreadable, starting empty");
    return new Map();
  }
  const file = raw as Partial<VerdictFile>;
  if (typeof file?.model !== "string" || file.verdicts === undefined) {
    console.log(
      "verdict memory: written before the model was recorded, so it is discarded." +
        " Every page will be judged again by the current model.",
    );
    return new Map();
  }
  if (file.model !== CLASSIFIER_MODEL) {
    console.log(
      `verdict memory: written by ${file.model}, and the classifier is now ${CLASSIFIER_MODEL}.` +
        " Discarded rather than replayed.",
    );
    return new Map();
  }
  return new Map(Object.entries(file.verdicts));
})();

/**
 * Pages the one-word triage ruled out during *this* run.
 *
 * Deliberately not persisted, and deliberately not part of `verdicts`. It exists
 * only so two sources carrying byte-identical text are not asked twice in the
 * same round.
 */
const triagedOutThisRun = new Set<string>();

/**
 * Does this text say anything about training, in either language?
 *
 * Deliberately generous, and deliberately not clever. It is only ever used to
 * decide whether a page is worth *paying* to have judged, and the cost of a
 * false positive is one cent while the cost of a false negative is a semester.
 * So every spelling that appears on a Saudi page is here, including the ones a
 * tighter pattern would miss — تدريب without تعاوني, المتدربين, تمهير, and the
 * bare English words.
 *
 * Note it does not exclude "cooperation": that trap matters when *classifying*
 * a url, and here an extra classification costs a cent and loses nothing.
 */
const MENTIONS_TRAINING =
  /تدريب|تدريبي|متدرب|المتدربين|تعاون|تمهير|طلاب|طالبات|خريج|فرص|توظيف|وظائف|تأهيل|co-?op|intern|trainee|training|career|graduate|student/i;

/**
 * Whether a page must be judged whatever its text says.
 *
 * A page that has told us it is about cooperative training, or that sits at a
 * careers address, is always sent. Those are few, they are the whole point, and
 * no saving is worth the chance of skipping one. The filter below exists for
 * the hundred and forty news pages and media centres that move every day and
 * say nothing — which is where the money actually goes.
 */
const alwaysJudge = new Set<string>();
for (const o of orgs) {
  for (const s of o.sources) {
    if (s.coopConfirmed === true || s.type === "careers_page" || s.type === "portal") {
      alwaysJudge.add(s.url);
    }
  }
}

/**
 * What each source is worth reading first.
 *
 * The budget below is finite, and without an order it is spent in whatever
 * sequence the sources happen to sit in. That would be actively harmful now
 * that every organisation is watched on its news page as well: a media centre
 * publishes something most days, so its hash moves every run, while the co-op
 * page it sits beside moves twice a year — and the pages that change constantly
 * would eat the budget in front of the one page this application exists to
 * read.
 *
 * So a page that has said it is about cooperative training is judged first,
 * then careers pages, then everything else.
 */
const sourceRank = new Map<string, number>();
for (const o of orgs) {
  for (const s of o.sources) {
    sourceRank.set(
      s.url,
      s.coopConfirmed === true ? 0
      : s.type === "careers_page" || s.type === "portal" ? 1
      : s.type === "announcement_page" ? 2
      : 3,
    );
  }
}

const owed = [...snapshotByUrl.values()]
  .filter((s) => (RECLASSIFY || s.pendingClassification) && textByUrl.has(s.sourceUrl))
  .sort((a, b) => (sourceRank.get(a.sourceUrl) ?? 3) - (sourceRank.get(b.sourceUrl) ?? 3));

/*
 * A dry run does not spend money either.
 *
 * The banner says "nothing will be written", which reads as "this costs
 * nothing" — and it did not: classification ran and was billed, only the files
 * were left alone. `--no-classify` is still there for the opposite case, where
 * the writing is wanted and the spending is not.
 */
if (DRY_RUN && owed.length > 0) {
  console.log(`\ndry run: ${owed.length} page(s) would be classified; no API call was made.`);
}

/*
 * A ceiling on what one run may spend.
 *
 * The person paying for this is a student, and the source list keeps growing:
 * every organisation is now watched on every channel it publishes, so a day
 * when many pages move is a day when many pages are classified. A runaway run
 * is not hypothetical — one badly-behaved page whose hash churns every six
 * hours would bill four times a day for ever.
 *
 * Hitting the ceiling is not a failure and nothing is lost. The pages that did
 * not fit keep `pendingClassification`, which is exactly the flag that means
 * "still owed a verdict", so the next run picks them up first. Override with
 * RASID_RUN_BUDGET_USD when a deliberate catch-up is wanted.
 */
/*
 * The ceiling is minutes now, not dollars.
 *
 * It used to be $0.50 of API spend. The model moved onto this machine and the
 * price went to zero, which silently disabled the guard: `costOf(spend) >= 0.5`
 * can never be true when every call costs nothing, so a round with two hundred
 * changed pages would have ground away for hours with nothing to stop it. A
 * budget that cannot be exceeded is not a budget, and removing the line
 * altogether would have been worse - it would have looked deliberate.
 *
 * So the scarce resource is named correctly. It is the owner's processor, and
 * the unit is seconds. Nothing is lost when the ceiling is hit: the pages that
 * did not fit keep `pendingClassification` and are picked up first next round,
 * exactly as before.
 */
const RUN_BUDGET_SECONDS = Number(process.env.RASID_RUN_BUDGET_SECONDS ?? 900);
let budgetStopped = 0;
const classifyStartedAt = Date.now();
const secondsSpentClassifying = (): number => (Date.now() - classifyStartedAt) / 1000;

if (!NO_CLASSIFY && !DRY_RUN) {
  for (const snap of owed) {
    // Either ceiling stops it: the processor budget, or the caller's deadline.
    // Whichever is tighter wins, and the pages that did not fit keep
    // `pendingClassification` and are judged first next round.
    if (secondsSpentClassifying() >= RUN_BUDGET_SECONDS || outOfTime()) {
      budgetStopped++;
      continue;
    }
    const text = textByUrl.get(snap.sourceUrl) ?? "";

    /*
     * Do not pay to be told "no".
     *
     * A hundred and forty of these sources are news pages and media centres.
     * They move every day — a new story, a rotated banner, a date — so every
     * round asked the model about each of them and every round it answered that
     * this is not a training announcement. At a cent a page that was two to
     * four dollars a day to hear "no" repeatedly, which is most of the bill and
     * all of the waste.
     *
     * A page whose changed text does not contain a single training word in
     * either language cannot be a training announcement, and that is a free
     * check. Three things keep it safe: confirmed co-op pages and careers pages
     * are never filtered, the vocabulary is deliberately loose enough that a
     * false positive is likelier than a false negative, and every skip is
     * counted and printed rather than passing in silence.
     *
     * `--reclassify` bypasses it, for a run that is meant to re-judge
     * everything regardless.
     */
    if (!RECLASSIFY && !alwaysJudge.has(snap.sourceUrl) && !MENTIONS_TRAINING.test(text)) {
      skippedByFilter++;
      // Nothing is owed a verdict that cannot contain one. Clearing the flag
      // stops the page being carried forward as an unpaid debt for ever.
      snap.pendingClassification = false;
      // ...and saying so on the snapshot, because a run-total in a rotating log
      // is not an answer to "which pages were never judged, and why".
      snap.settledWithoutVerdict = "no_training_word";
      continue;
    }

    /*
     * Never pay twice for the same words.
     *
     * A page whose text returns to something already judged — a banner that
     * rotates between two states, a listing that reorders and reverts — moves
     * its hash every round and was billed every round for an answer already
     * known. The text is the whole input to the verdict, so identical text has
     * an identical answer, and looking it up is free.
     */
    const fingerprint = sha256(text).slice(0, 32);

    /*
     * A one-word guess is not a judgement, and is never remembered past this run.
     *
     * The triage answer used to be written into the same durable memory as a
     * full classification, as `null`. But the two are not the same kind of
     * thing. A full classification has read seventeen fields and concluded that
     * the page carries no announcement; the triage has answered one word, from a
     * reply parser that reads *any* Arabic sentence opening with the letters lam
     * and alif as "no" — including "لا شك أنها إعلان تدريب تعاوني". A page whose
     * text does not change, which is most of them, was therefore silenced for
     * ever by a single misread word, and nothing anywhere would have said so.
     *
     * Within one run the answer is still worth reusing, because two sources can
     * carry byte-identical text. Across runs the page is asked again, at the
     * cost of one local word.
     */
    if (!RECLASSIFY && triagedOutThisRun.has(fingerprint)) {
      fromMemory++;
      notAnnouncements++;
      snap.pendingClassification = false;
      continue;
    }

    const remembered = verdicts.get(fingerprint);
    /*
     * A remembered verdict faces the same guard a fresh one does.
     *
     * `notCopiedFrom` lives inside `classify()`, so this branch — which skips
     * `classify()` entirely, that being the point of it — was the one route
     * into the dataset that never checked whether the model's wording is
     * actually on the page. A verdict recorded before the guard existed was
     * therefore replayed for ever, and could not be dislodged: the page has not
     * changed, so the fingerprint matches, so the same answer comes back.
     *
     * The text is right here, so checking costs a substring search. A verdict
     * that fails is dropped from the memory and the page falls through to be
     * judged again below, which is exactly what should have happened the first
     * time.
     */
    if (!RECLASSIFY && remembered != null) {
      const invented = notCopiedFrom(text, remembered);
      if (invented.length > 0) {
        verdicts.delete(fingerprint);
        poisonedVerdicts++;
        reviewQueue.push(
          `  ${snap.orgId.padEnd(14)} ${"stale verdict".padEnd(15)} remembered wording is not on the page: ${invented
            .slice(0, 2)
            .join("; ")}`,
        );
        // Fall through: it is judged again this round, by the current model.
      }
    }
    if (!RECLASSIFY && verdicts.get(fingerprint) !== undefined) {
      const cached = verdicts.get(fingerprint);
      fromMemory++;
      snap.pendingClassification = false;
      if (cached === null || cached === undefined) {
        notAnnouncements++;
        continue;
      }
      const prior = priorOpportunities.find(
        (o) => o.orgId === snap.orgId && o.sourceUrl === snap.sourceUrl,
      );
      for (const [id, o] of opportunityById) {
        if (o.sourceUrl === snap.sourceUrl) opportunityById.delete(id);
      }
      const record = fromClassification({
        orgId: snap.orgId,
        sourceUrl: snap.sourceUrl,
        text,
        nowISO: now,
        prior,
        firstTime: prior
          ? prior.flags.includes("first_time_seen")
          : !orgsWithHistory.has(snap.orgId),
        c: cached,
      });
      opportunityById.set(record.id, record);
      classified++;
      continue;
    }

    /*
     * One word before seventeen fields.
     *
     * Pages already known to be about training skip this and go straight to the
     * full question. Everything else is asked, in a form answerable in one
     * word, whether it is worth the expensive question at all.
     */
    if (!RECLASSIFY && !alwaysJudge.has(snap.sourceUrl)) {
      const first = await triage(text);
      addUsage(spend, first.usage);
      if (!first.looksLikeAnnouncement) {
        triagedOut++;
        notAnnouncements++;
        snap.pendingClassification = false;
        snap.settledWithoutVerdict = "triaged_out";
        // In-run only. See the note above the memory lookup: a triage "no" is a
        // guess, and a guess must not be able to silence a page permanently.
        triagedOutThisRun.add(fingerprint);
        continue;
      }
    }

    const prior = priorOpportunities.find(
      (o) => o.orgId === snap.orgId && o.sourceUrl === snap.sourceUrl,
    );
    const common = {
      orgId: snap.orgId,
      sourceUrl: snap.sourceUrl,
      text,
      nowISO: now,
      prior,
      /*
       * Decided once, then carried. Records are rebuilt every run, so asking
       * "did this organisation have a record when this run started" answered
       * yes from the second run onward and the flag quietly vanished from an
       * announcement that really was an organisation's first. Whatever the
       * first sighting concluded is what stays true about that announcement.
       */
      firstTime: prior
        ? prior.flags.includes("first_time_seen")
        : !orgsWithHistory.has(snap.orgId),
    };

    const result = await classify(text);
    addUsage(spend, result.usage);

    if (!result.ok) {
      const note = `${result.stage} — ${result.reason}`;
      /*
       * The hash stays, the debt stays, and nothing is scored.
       *
       * A previously valid verdict is not erased by a failed re-check: it is
       * kept and flagged, so the user still sees what the page last said while
       * knowing it could not be confirmed this run. Only a source that has
       * never been judged gets a bare placeholder. Either way exactly one
       * record exists per source.
       */
      /*
       * The test is "does a real reading of this page survive", not "is it
       * unflagged". Those two came apart on the second consecutive failure:
       * round one flagged the good record `needs_manual_review`, and round two
       * then failed to find it precisely *because* of that flag, fell to the
       * branch below, and deleted the judgement round one had just preserved.
       * A source that stays unreachable for two rounds is the ordinary case,
       * not the rare one, so this ran often.
       */
      const existing = survivingRecord(opportunityById.values(), snap.sourceUrl);
      if (existing) {
        /*
         * Deduplicated, because this runs on every failed round in a row and a
         * plain append gave a record two copies of the same flag. The schema
         * forbids duplicates, so the validator failed the whole dataset and the
         * deploy with it — a source that stayed unreadable for two rounds was
         * enough to stop publishing everything else.
         */
        existing.flags = [...new Set([...existing.flags, "needs_manual_review" as const])];
        /*
         * The humanised sentence, not the diagnostic. This line is read on a
         * phone; `note` is written for whoever is reading the run log, and
         * pasting it here is how ninety cards ended up carrying a paragraph of
         * English JSON about a credit balance.
         *
         * Guarded against repetition too: the note used to be appended on every
         * failed round, so a source that stayed unreachable for a day grew four
         * copies of the same parenthesis.
         */
        const retryNote = `(لم يُتحقّق في آخر جولة: ${humanReason(`${result.stage} ${result.reason}`)})`;
        existing.relevanceReason = existing.relevanceReason.includes("لم يُتحقّق في آخر جولة")
          ? existing.relevanceReason
          : `${existing.relevanceReason} ${retryNote}`;
      } else {
        for (const [id, o] of opportunityById) {
          if (o.sourceUrl === snap.sourceUrl) opportunityById.delete(id);
        }
        const record = asManualReview({ ...common, reason: note });
        opportunityById.set(record.id, record);
      }
      snap.pendingClassification = true;
      reviewQueue.push(`  ${snap.orgId.padEnd(14)} ${result.stage.padEnd(15)} ${result.reason}`);
      continue;
    }

    snap.pendingClassification = false;
    delete snap.settledWithoutVerdict;
    /*
     * One source, one current record.
     *
     * The id is a hash of the title, so a page whose wording shifts between
     * runs would mint a second id and leave the first behind: two entries for
     * one page, with two different scores, and no way for a reader to tell
     * which is live. The verdict just produced supersedes whatever this source
     * said before, so the old entry goes. `prior` has already carried
     * firstSeenISO across, so the record keeps its history.
     */
    /*
     * A negative verdict never deletes. It used to, and that was the worst bug
     * in this file.
     *
     * The delete loop ran *before* the isTrainingAnnouncement check, so any run
     * where a watched page stopped mentioning training threw the record away in
     * silence — and a page stops mentioning training for reasons that have
     * nothing to do with the announcement ending: a redesign, a cookie wall, a
     * maintenance banner, a soft 404 that answers 200, or the extractor
     * latching onto navigation. An audit proved it by destroying a seeded open
     * window, score 95, three seats, closing in eleven days, in a single round,
     * with no notification of any kind. He would simply have found it gone.
     *
     * So the record is kept, marked as no longer visible on its page, and the
     * disappearance is something the notifier can tell him about. Deletion now
     * requires a positive replacement, which is the only thing that proves the
     * page still holds an announcement.
     */
    // Remembered against the text that produced it, so identical text is never
    // paid for again — including the "no", which is most of what is bought.
    verdicts.set(
      sha256(text).slice(0, 32),
      result.value.isTrainingAnnouncement ? result.value : null,
    );

    if (!result.value.isTrainingAnnouncement) {
      notAnnouncements++;
      // `lastConfirmedISO` is deliberately not touched: it was not confirmed
      // today, and moving it would say the opposite.
      for (const o of markVanished(opportunityById.values(), snap.sourceUrl).flagged) {
        vanished.push(`  ${snap.orgId.padEnd(14)} ${o.titleAr}`);
      }
      continue;
    }

    /*
     * One source, one current record.
     *
     * The id is a hash of the title, so a page whose wording shifts between
     * runs would mint a second id and leave the first behind: two entries for
     * one page, with two different scores, and no way for a reader to tell
     * which is live. The verdict just produced supersedes whatever this source
     * said before, so the old entry goes. `prior` has already carried
     * firstSeenISO across, so the record keeps its history.
     */
    for (const [id, o] of opportunityById) {
      if (o.sourceUrl === snap.sourceUrl) opportunityById.delete(id);
    }
    const record = fromClassification({ ...common, c: result.value });
    opportunityById.set(record.id, record);
    classified++;
  }
}

/*
 * A card that promises a verdict nobody owes it any more.
 *
 * Measured on 2026-09-03: of 136 records flagged `needs_manual_review`, **88
 * were stuck for ever**. The route in is not exotic, it is the ordinary one:
 *
 *   1. Classification fails — the model is down, or a schema miss. A placeholder
 *      record is minted, titled "لم يُصنَّف بعد", and `pendingClassification`
 *      is set. Correct.
 *   2. A later round fetches the page unchanged, carries the flag forward, and
 *      the page enters `owed`. Still correct.
 *   3. The cost filter finds no training word in it, clears
 *      `pendingClassification`, and moves on. Also correct, on its own terms.
 *   4. Nothing anywhere reconciles the two. The page is settled and the card
 *      that says otherwise is left standing.
 *
 * Two screens then lie about it. Each card reads "هي محفوظة في الطابور
 * وستُقرأ في جولة قادمة" — it will be read in a coming round — and
 * `npm run status` says the queue drains by itself every round. Neither was
 * true for 65% of it.
 *
 * The placeholder is dropped rather than re-flagged, because it carries nothing
 * to keep: no title, no dates, no score, no majors. It is the *absence* of a
 * verdict wearing the shape of a record. The page itself stays watched, its
 * snapshot and its health row are untouched, and the moment its text changes it
 * is judged like anything else — so nothing about coverage moves. What moves is
 * that the app stops promising something it will not do.
 *
 * Dropped loudly. A count goes to the round summary, because a record leaving
 * the dataset is never something this project does quietly.
 */
let settledPlaceholders = 0;
for (const [id, o] of opportunityById) {
  if (o.titleAr !== UNJUDGED_TITLE) continue;
  if (!o.flags.includes("needs_manual_review")) continue;
  const snap = snapshotByUrl.get(o.sourceUrl);
  // Still owed a verdict, or we have no snapshot to judge by: leave it alone.
  if (snap === undefined || snap.pendingClassification) continue;
  opportunityById.delete(id);
  settledPlaceholders++;
}
if (settledPlaceholders > 0) {
  console.log(
    `\n${settledPlaceholders} unjudged placeholder(s) dropped: their pages are settled, so the card` +
      ` promising "it will be read in a coming round" was false. The pages stay watched.`,
  );
}

/*
 * Every record's status is recomputed before anything is written.
 *
 * Not only the ones classified this run — every one. A record whose page has
 * not moved is never reclassified, and its window opens and closes on the
 * calendar regardless. Storing a status computed weeks ago and then never
 * revisiting it is what made a window that had been open for ten days still
 * read "أُعلن ولم يفتح", with no alert ever sent. The dates are the fact; the
 * status is a view of them at a moment, and the moment is now.
 */
let restated = 0;
for (const [id, o] of opportunityById) {
  const fresh = statusFor(o, Date.parse(now));
  if (fresh === o.status) continue;
  const flags = new Set(o.flags);
  if (fresh === "closing_soon") flags.add("closing_in_48h");
  else flags.delete("closing_in_48h");
  opportunityById.set(id, { ...o, status: fresh, flags: [...flags] });
  restated++;
}
if (restated > 0) console.log(`\n${restated} record(s) moved to a new window state by the calendar`);

if (VERBOSE) console.log(lines.sort().join("\n") + "\n");

const health = [...healthByUrl.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));

/*
 * The diff base moves only for pages that reached a verdict.
 *
 * `pendingClassification` is exactly that fact by the time we get here: every
 * route that settles a page clears it, and every route that leaves a page owed
 * one keeps it set — a round that fetched without judging, a classification
 * that failed, a page the budget or the deadline did not reach. So a page still
 * in debt keeps the base it had, and its unjudged blocks stay "new" until
 * something actually reads them.
 */
let baseHeld = 0;
for (const [url, snap] of snapshotByUrl) {
  const fresh = freshBlockHashes.get(url);
  if (fresh === undefined) continue; // not fetched this round; nothing to promote
  if (snap.pendingClassification) {
    baseHeld++;
    continue;
  }
  snap.blockHashes = fresh;
}
if (baseHeld > 0) {
  console.log(
    `\n${baseHeld} page(s) still owe a verdict, so their text stays new until it is read`,
  );
}

const snapshots = [...snapshotByUrl.values()].sort((a, b) =>
  a.sourceUrl.localeCompare(b.sourceUrl),
);

/**
 * Written to a neighbouring file and renamed over the target.
 *
 * A rename within a directory is atomic on every filesystem this runs on, so a
 * reader either sees the whole previous file or the whole new one. A plain
 * write is neither: a crash, a full disk, or a machine going to sleep partway
 * through leaves truncated JSON, and `data/organisations.json` truncated is the
 * one file that stops every script and the app at once. The app fails loudly on
 * it, which is right, but it should not be possible to get there by accident.
 */
/**
 * Write to a scratch file, then move it into place in one step.
 *
 * The scratch name carries this process's id. It did not, so two rounds writing
 * at the same moment shared one temporary file: the second overwrote the first
 * mid-write, and whichever renamed last published a file the other had been
 * halfway through producing. That is precisely the torn write the rename is
 * there to prevent, reintroduced by the name. Two rounds at once is meant to be
 * impossible and now is — the launcher refuses a second watcher — but a
 * guarantee that depends on another file's correctness is not a guarantee.
 */
function writeAtomic(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}

if (!DRY_RUN) {
  writeAtomic("data/health.json", JSON.stringify(health, null, 2) + "\n");
  writeAtomic("data/snapshots.json", JSON.stringify(snapshots, null, 2) + "\n");
  // Only rewritten when a promotion actually happened, so an ordinary run
  // never touches the dataset the whole project is built on.
  if (promotions.length > 0) {
    writeAtomic("data/organisations.json", JSON.stringify(orgs, null, 2) + "\n");
  }
  const opportunities = [...opportunityById.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeAtomic("data/opportunities.json", JSON.stringify(opportunities, null, 2) + "\n");

  /*
   * Whose fit the scores describe, so the app can say it out loud.
   *
   * Every relevance score in this dataset is computed against one stored
   * profile, and the interface presented them as though they were properties of
   * the announcement: a bare number labelled "صلة", and a chip reading
   * "تخصصي مقبول" on all hundred and fifteen organisations. For the person who
   * wrote the profile that is merely terse. For a friend he shares the link
   * with, it is wrong — the number is about somebody else and nothing said so.
   *
   * Only the field label goes in, never the profile: it is one phrase, it is
   * already visible in every relevanceReason, and it is what makes the number
   * honest instead of anonymous.
   */
  const basisProfile = readProfile(studentProfile() ?? "");
  writeAtomic(
    "data/score-basis.json",
    JSON.stringify(
      {
        fieldLabel: basisProfile?.fieldLabel ?? null,
        computedISO: now,
      },
      null,
      2,
    ) + "\n",
  );

  /*
   * The verdict memory, bounded. Newest kept; the oldest fall off, because a
   * page whose text has not been seen in months will be re-read as new anyway
   * and there is no point carrying it for ever.
   */
  const MAX_REMEMBERED = 3_000;
  const kept = [...verdicts.entries()].slice(-MAX_REMEMBERED);
  const verdictFile: VerdictFile = {
    model: CLASSIFIER_MODEL,
    writtenISO: now,
    verdicts: Object.fromEntries(kept),
  };
  writeAtomic(VERDICTS_FILE, JSON.stringify(verdictFile, null, 2) + "\n");
}

const byState = (s: HealthState): number => health.filter((h) => h.state === s).length;
console.log("run");
console.log(`  changed                ${String(tally.changed).padStart(3)}`);
console.log(`  unchanged              ${String(tally.unchanged).padStart(3)}`);
console.log(`  skipped by robots.txt  ${String(tally.robots_skip).padStart(3)}`);
console.log(`  no readable text       ${String(tally.unreadable).padStart(3)}`);
console.log(`  failed                 ${String(tally.failed).padStart(3)}`);
console.log("\nhealth file");
console.log(`  healthy                ${String(byState("healthy")).padStart(3)}`);
console.log(`  degraded               ${String(byState("degraded")).padStart(3)}`);
console.log(`  broken                 ${String(byState("broken")).padStart(3)}`);
// The spec's thresholds call a single failure "healthy", so a source can be
// green and still be carrying a live error. Print that separately rather than
// let the state column imply everything is fine.
const carryingError = health.filter((h) => h.lastError !== null).length;
console.log(`  carrying a live error  ${String(carryingError).padStart(3)}`);

// The fallback path keeps a source alive but its text is noisier, so knowing
// how much of the dataset rests on it is worth a line of its own.
const fallback = snapshots.filter((s) => s.extractionMethod === "body_fallback");
console.log("\nextraction");
console.log(
  `  readability            ${String(snapshots.length - fallback.length).padStart(3)}`,
);
console.log(`  body fallback          ${String(fallback.length).padStart(3)}`);

// Thin and unmoving for long enough to be worth a human glance. Not an error:
// a training page with nothing on it is the normal state out of season.
const silent = snapshots.filter(
  (s) => s.thinRuns >= SILENT_THIN_RUNS && (s.extractedChars ?? 0) < THIN_CHARS,
);
if (silent.length > 0) {
  console.log("\nsilent thin sources");
  for (const s of silent) {
    console.log(
      `  ${s.orgId.padEnd(14)} ${String(s.extractedChars).padStart(5)} chars, unchanged for ${s.thinRuns} runs`,
    );
  }
}

if (promotions.length > 0) {
  console.log("\npromoted to browser in CI");
  console.log(promotions.join("\n"));
}

console.log(`\nclassification (${NO_CLASSIFY ? "skipped" : CLASSIFIER_MODEL})`);
console.log(`  owed a verdict         ${String(owed.length).padStart(3)}`);
console.log(`  announcements          ${String(classified).padStart(3)}`);
console.log(`  not an announcement    ${String(notAnnouncements).padStart(3)}`);
console.log(`  needs manual review    ${String(reviewQueue.length).padStart(3)}`);
console.log(`\nwhat was not paid for`);
console.log(`  no training word       ${String(skippedByFilter).padStart(3)}  (never sent, free)`);
console.log(`  ruled out in one word  ${String(triagedOut).padStart(3)}  (asked cheaply, not judged in full)`);
console.log(`  answered from memory   ${String(fromMemory).padStart(3)}  (identical text already judged)`);
console.log(`  vanished from source   ${String(vanished.length).padStart(3)}`);
if (vanished.length > 0) {
  console.log("\nno longer visible on the page that announced them:");
  console.log(vanished.join("\n"));
}
/*
 * Tokens still, because a stage that stops producing them has stopped running
 * and that must be visible. The price beside them is a real measurement and not
 * a decoration: it is zero because the model is on this machine, and printing
 * it keeps the claim falsifiable. If it is ever not zero, something has been
 * quietly wired back to a paid API.
 */
console.log(
  `  tokens                 ${spend.inputTokens} in / ${spend.outputTokens} out = $${costOf(spend).toFixed(4)}`,
);
console.log(
  `  local inference        ${secondsSpentClassifying().toFixed(0)}s of ${RUN_BUDGET_SECONDS}s budget`,
);
if (budgetStopped > 0) {
  console.log(
    `  budget                 stopped at ${RUN_BUDGET_SECONDS}s; ${budgetStopped} page(s) still owed a verdict and will be judged next run`,
  );
}
/*
 * Said out loud, because a round that stopped early and a round that read
 * everything otherwise look identical in this report, and the difference is the
 * whole point of having a deadline.
 */
if (ranOutOfTime > 0) {
  console.log(
    `  deadline               reached after ${((Date.now() - runStartedAt) / 1000).toFixed(0)}s; ${ranOutOfTime} source(s) not opened and still due`,
  );
}

// Never a silent queue. Every unjudged source is named, with why it failed.
if (reviewQueue.length > 0) {
  console.log("\nneeds manual review");
  console.log(reviewQueue.join("\n"));
  console.log("  these keep their hash and stay queued for the next run.");
}
if (browserTargets.length > 0 && browserUnavailable()) {
  console.log(
    "\nheadless chromium never launched, so the rendered sources are recorded as degraded.\n" +
      'The static half of this run completed normally. Fix with "npx playwright install chromium".',
  );
}
if (DRY_RUN) console.log("\ndry run: data/health.json and data/snapshots.json were not touched.");

/*
 * Everything is written by this point, so the round is finished whatever is
 * still open.
 *
 * A phase abandoned at the deadline leaves its sockets and timers behind, and
 * node will not exit while a handle is alive — so without this the process would
 * sit there after a successful write, looking exactly like the hang it was
 * added to survive. The lock is released by the `exit` handler above.
 */
process.exit(0);
