/**
 * The resident watcher: reads what is due, forever, while the machine is on.
 *
 * The owner leaves this PC running most of the day and asked for it to watch
 * continuously rather than four times a day, notifying him only when there is
 * something. This is that, with two departures from the literal request, both
 * of which are explained where they are implemented:
 *
 *   - It does not read every source every cycle. See src/pipeline/schedule.ts:
 *     a full sweep every two minutes is ninety times the current load on Saudi
 *     government hosts from one home address, and that address is measurably
 *     the best reader this project has.
 *
 *   - Silence is never allowed to mean safety. No notification is sent when
 *     nothing is found, exactly as asked - but the heartbeat is written every
 *     cycle so the application can always say when it last looked, and a long
 *     gap is itself something the owner is told about.
 *
 * Each cycle runs the collector as a child process rather than in this one.
 * That is deliberate: a leak, a wedged headless browser or an out-of-memory
 * kill takes the cycle and not the watcher, and the next cycle starts from a
 * clean interpreter. A resident process that quietly stops collecting while
 * still looking alive is the exact failure this project exists to refuse.
 *
 *   npx tsx scripts/watch.ts
 *   npx tsx scripts/watch.ts --once      one cycle, then exit
 *   npx tsx scripts/watch.ts --dry-run   pick the due sources, fetch nothing
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_GAP_MINUTES,
  INTERVAL_MINUTES,
  clampAfterSleep,
  dueNow,
  hostCounts,
  markChecked,
  reconcile,
  tierOf,
  type Due,
  type Tier,
} from "../src/pipeline/schedule";
import type { AggregatorSource, Opportunity, Organisation } from "../src/types";
import { loadEnvFile } from "../src/pipeline/env";

/* Secrets live in a gitignored .env on this machine. Read before anything
 * asks process.env for one: a scheduled task starts with a bare environment,
 * and a missing subscription makes the notifier skip silently. */
loadEnvFile();

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const DRY_RUN = args.includes("--dry-run");

const STATE_DIR = ".rasid";
const STATE_FILE = join(STATE_DIR, "schedule.json");
const DUE_FILE = join(STATE_DIR, "due.txt");

/** How many sources one cycle may read. Bounds a cycle, not a day. */
const MAX_PER_CYCLE = Number(process.env.RASID_MAX_PER_CYCLE ?? 40);
/** How long to wait when nothing is due. */
const IDLE_MS = 60_000;

const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

/**
 * Local time, because this line is read by a person in Riyadh.
 *
 * It was `toISOString()`, which is UTC, and the wrapper that starts this
 * writes its own lines in local time - so watch.log carried two clocks three
 * hours apart in consecutive lines. Every ISO date the pipeline *stores* stays
 * UTC and should; this is the one place where the reader is a human looking at
 * a log to see whether the thing ran.
 */
const stamp = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const say = (msg: string): void => console.log(`[${stamp()}] ${msg}`);

/**
 * Is a game in the foreground?
 *
 * The owner plays League of Legends on this machine and asked, reasonably, that
 * watching never cost him frames. Two things already make that unlikely: the
 * model is pinned to the CPU so the graphics card is never asked for anything,
 * and a cycle is a couple of minutes of mostly waiting on the network.
 *
 * This is the third guard, and it is cheap. While a listed process is running,
 * the cycle still fetches - fetching is nearly free and losing an hour of
 * coverage would be the real cost - but it passes --no-classify, so no
 * inference runs. The pages are hashed, the debt is recorded, and they are
 * judged the moment the game closes. A window lives for days; a match lasts
 * half an hour.
 *
 * The list is an environment variable because only the owner knows what he
 * plays.
 */
function gameRunning(): string | null {
  const names = (process.env.RASID_PAUSE_PROCESSES ?? "League of Legends,VALORANT-Win64-Shipping,csgo,cs2,FortniteClient-Win64-Shipping")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return null;

  /*
   * A timeout, because this call is on the critical path of every cycle.
   *
   * `runNode` passes one and this did not, so a `tasklist.exe` that wedged took
   * the whole watcher with it — no round, no log line, no exit, just a process
   * sitting there looking alive. Ten seconds is far beyond what it takes on a
   * loaded machine, and failing the check is harmless: not knowing whether a
   * game is running is not a reason to pause, and the round goes ahead.
   */
  const res = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (res.status !== 0 || !res.stdout) return null; // Not knowing is not a reason to pause.
  const running = res.stdout.toLowerCase();
  for (const n of names) {
    /*
     * The suffix is added here, so the configured name must not carry one.
     * `RASID_PAUSE_PROCESSES=cs2.exe` searched for "cs2.exe.exe" and matched
     * nothing, which is a setting that looks obviously right and silently does
     * nothing. Both spellings are accepted now.
     */
    const bare = n.toLowerCase().replace(/\.exe$/, "");
    if (running.includes(`"${bare}.exe"`)) return n;
  }
  return null;
}

/**
 * Whether a parsed value is really one scheduled source.
 *
 * `JSON.parse` succeeding is not the same as the file holding a schedule. It
 * succeeds for `{}`, for `null`, for a bare number, for a string — and the cast
 * that used to follow it asserted an array where there was none, so the first
 * `.map` in the cycle threw a TypeError inside the watcher's own loop and the
 * process sat there alive, looping, reading nothing, for ever. That is the exact
 * shape of failure this project refuses: not a crash, a silence.
 */
function isDue(v: unknown): v is Due {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.sourceUrl === "string" &&
    typeof d.orgId === "string" &&
    typeof d.tier === "string" &&
    typeof d.nextCheckAt === "number" &&
    Number.isFinite(d.nextCheckAt) &&
    (d.lastCheckedAt === null || typeof d.lastCheckedAt === "number")
  );
}

function loadState(): Due[] {
  if (!existsSync(STATE_FILE)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    // A corrupt schedule is not worth a crash. Rebuilding it costs one spread
    // cycle and nothing else; the dataset itself is untouched by this file.
    say("schedule.json was unreadable and has been rebuilt");
    return [];
  }
  if (!Array.isArray(parsed)) {
    say("schedule.json parsed but is not a list of sources, and has been rebuilt");
    return [];
  }
  /*
   * Bad rows are dropped one at a time rather than the whole file: a schedule
   * that has lost one entry costs that source a single spread cycle, while
   * throwing the file away re-spreads all four hundred.
   */
  const rows = parsed.filter(isDue);
  if (rows.length !== parsed.length) {
    say(`schedule.json had ${parsed.length - rows.length} unusable row(s), which were dropped`);
  }
  return rows;
}

function saveState(state: Due[]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Every verified source, with the tier it sits in right now. */
function currentTargets(nowMs: number): { sourceUrl: string; orgId: string; tier: Tier }[] {
  const orgs = read<Organisation>("data/organisations.json");
  const aggregators = read<AggregatorSource>("data/aggregators.json");
  const opportunities = read<Opportunity>("data/opportunities.json");

  const out: { sourceUrl: string; orgId: string; tier: Tier }[] = [];
  for (const o of orgs) {
    for (const s of o.sources) {
      if (s.verifiedAtISO === null) continue;
      out.push({
        sourceUrl: s.url,
        orgId: o.id,
        tier: tierOf(s.url, o, s.type, s.coopConfirmed === true, opportunities, nowMs),
      });
    }
  }
  for (const a of aggregators) {
    if (a.link === null || a.link.verifiedAtISO === null) continue;
    out.push({ sourceUrl: a.link.url, orgId: a.id, tier: "low" });
  }
  return out;
}

/**
 * How long one child may run before it is killed.
 *
 * A cycle that never returns is worse than a cycle that fails, because the
 * watcher is the thing that has to still be running tomorrow: it would sit
 * there looking alive, reading nothing, while the application went on showing
 * a calm "checked N minutes ago". That is precisely the stale green light this
 * project exists to refuse.
 *
 * The first version of this file had no timeout at all, and it did not take
 * long to matter: a robots.txt pass over forty hosts, where an unreachable one
 * costs three attempts at twenty seconds plus a headless-browser fallback, ran
 * past a quarter of an hour on its first real cycle.
 *
 * Killing it loses the entire round. This comment used to claim the opposite —
 * that the pages already read had already been written — and that was simply
 * untrue: the collector writes every file at the end, in one block, so a child
 * killed at minute twelve has saved nothing at all. Worse, the collector's own
 * ceiling was fifteen minutes *of inference alone*, so on a long round the kill
 * was not an exception, it was the guaranteed outcome.
 *
 * So the kill is now the last resort rather than the mechanism. The collector is
 * given a deadline of its own, derived from this one, and is expected to stop
 * reading and write what it has well before the timer fires. If the timer ever
 * does fire, something is genuinely wedged, and `cycle` treats that differently
 * from an ordinary failure because nothing was recorded anywhere.
 */
const CHILD_TIMEOUT_MS = Number(process.env.RASID_CYCLE_TIMEOUT_MS ?? 12 * 60_000);

/**
 * How long the collector may spend before it has to stop and write.
 *
 * Derived, never configured separately: two independently set numbers is how
 * the previous pair came to contradict each other. The margin is what writing
 * four JSON files and closing a browser costs, with room to spare.
 */
const WRITE_MARGIN_MS = 90_000;
const COLLECT_DEADLINE_MS = Math.max(60_000, CHILD_TIMEOUT_MS - WRITE_MARGIN_MS);

function runNode(script: string, extra: string[]): number {
  const res = spawnSync(process.execPath, ["--import", "tsx", script, ...extra], {
    stdio: "inherit",
    env: { ...process.env, RASID_RUN_DEADLINE_MS: String(COLLECT_DEADLINE_MS) },
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (res.error && "code" in res.error && res.error.code === "ETIMEDOUT") {
    say(`${script} exceeded ${CHILD_TIMEOUT_MS / 60_000} minutes and was stopped`);
    /*
     * Killing the collector does not kill what the collector started.
     *
     * A wedged round is usually wedged on a page, and a page is rendered by a
     * headless browser the collector launched. SIGKILL on Windows ends that one
     * process and orphans its children, so every timed-out round left a
     * chromium tree behind — holding memory on the machine this is supposed to
     * stay out of the way of, and accumulating one tree per bad round until
     * something is restarted.
     *
     * Only browsers launched from this repository's own copy are touched, so a
     * browser the owner is using is never in scope.
     */
    reapOrphanedBrowsers();
    return 124; // the shell convention for "timed out", so the log is greppable
  }
  return res.status ?? 1;
}

/**
 * End the headless browsers a killed round left running.
 *
 * Matched on the repository's own browser directory, which is where the
 * launcher points Playwright, so nothing the owner opened himself can match.
 */
function reapOrphanedBrowsers(): void {
  if (process.platform !== "win32") return;
  const marker = join(process.cwd(), ".playwright").replace(/\\/g, "\\\\");
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome-headless-shell.exe' or Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*${marker}*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`;
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  const killed = (res.stdout ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (killed > 0) say(`  and ${killed} headless browser process(es) it had left behind`);
}

async function cycle(state: Due[]): Promise<Due[]> {
  const nowMs = Date.now();
  const targets = currentTargets(nowMs);
  const hosts = hostCounts(targets.map((t) => t.sourceUrl));
  let next = clampAfterSleep(reconcile(state, targets, nowMs, hosts), nowMs);

  const due = dueNow(next, nowMs, MAX_PER_CYCLE, hosts);
  const counts = due.reduce<Record<string, number>>((acc, d) => {
    acc[d.tier] = (acc[d.tier] ?? 0) + 1;
    return acc;
  }, {});

  if (due.length === 0) {
    const soonest = Math.min(...next.map((d) => d.nextCheckAt));
    say(`nothing due; next in ${Math.max(0, Math.round((soonest - nowMs) / 60_000))} min`);
    return next;
  }

  const paused = gameRunning();
  say(
    `${due.length} due (${Object.entries(counts).map(([t, n]) => `${t}:${n}`).join(" ")})` +
      (paused ? ` | ${paused} is running, fetching without judging` : ""),
  );

  if (DRY_RUN) {
    for (const d of due) say(`  would read ${d.tier.padEnd(6)} ${d.sourceUrl}`);
    return next;
  }

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(DUE_FILE, due.map((d) => d.sourceUrl).join("\n") + "\n", "utf8");

  const collectExit = runNode("scripts/collect.ts", [
    "--urls", DUE_FILE,
    ...(paused ? ["--no-classify"] : []),
  ]);
  say(`collect exit ${collectExit}`);

  /*
   * The schedule advances when the collector failed, and not when it was killed.
   *
   * Those two look alike in an exit code and are opposites in the file system. A
   * collector that fails has still written health.json: the failure is recorded
   * against each source, the application shows it, and leaving the source due
   * would make a permanently broken host the most overdue thing in the queue for
   * ever, retried every cycle, crowding out everything else. So it advances.
   *
   * A collector that was killed wrote nothing. No health row, no snapshot, no
   * record that the page was ever opened. Advancing there is the stale green
   * light this project exists to refuse: forty sources marked "checked" that
   * nobody looked at, invisible until their next turn comes round hours later.
   */
  const checkedAt = Date.now();
  const dueUrls = new Set(due.map((d) => d.sourceUrl));
  if (collectExit === 124) {
    say(`the round was killed before it could write, so ${due.length} source(s) stay due`);
  } else {
    next = next.map((d) => (dueUrls.has(d.sourceUrl) ? markChecked(d, checkedAt, hosts) : d));
  }

  if (collectExit === 0) {
    const notifyExit = runNode("scripts/notify.ts", []);
    say(`notify exit ${notifyExit}`);
    publish();
  } else {
    say("collect failed, so nothing was notified this cycle");
  }

  return next;
}

/**
 * Put what this round learned on the website.
 *
 * There was no code anywhere in the watcher that did this. The only `git push`
 * in the project lived in `scheduled-run.ps1`, the entry point of the *previous*
 * watcher, which has been disabled — so from the moment this one took over, the
 * collector went on reading every fifteen minutes into a repository that was
 * never pushed, and the published site froze on whatever it had last been shown
 * while the local data moved on without it. Everything looked healthy from here.
 *
 * Only `data/` is committed. The watcher must never carry up a source file
 * somebody is halfway through editing.
 */
function publish(): void {
  const git = (args: string[]): { ok: boolean; out: string } => {
    const r = spawnSync("git", args, { encoding: "utf8", timeout: 120_000 });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  };

  const dirty = git(["status", "--porcelain", "--", "data"]);
  if (!dirty.ok) {
    say(`publish: could not read git status, so nothing was pushed (${dirty.out.slice(0, 120)})`);
    return;
  }
  if (dirty.out === "") {
    say("publish: the data did not change, so there is nothing to push");
    return;
  }

  if (!git(["add", "--", "data"]).ok) {
    say("publish: could not stage data/");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const committed = git(["commit", "--quiet", "-m", `data: watcher round ${stamp}`]);
  if (!committed.ok) {
    say(`publish: commit failed (${committed.out.slice(0, 120)})`);
    return;
  }

  const pushed = git(["push", "--quiet", "origin", "HEAD"]);
  if (pushed.ok) {
    say("publish: pushed; the site will rebuild");
  } else {
    /*
     * Committed locally, so nothing this round read is lost. A push can fail
     * for reasons that have nothing to do with the data — no network, the
     * laptop on a captive portal, credentials expired — and the next successful
     * round carries this commit up with it.
     */
    say(`publish: committed locally but the push failed, it will go up next round (${pushed.out.slice(0, 120)})`);
  }
}

async function main(): Promise<void> {
  say(
    `watcher starting; intervals ${Object.entries(INTERVAL_MINUTES).map(([t, m]) => `${t}=${m}m`).join(" ")}` +
      `; no host read more than once per ${HOST_GAP_MINUTES}m`,
  );

  let state = loadState();
  for (;;) {
    try {
      state = await cycle(state);
      saveState(state);
    } catch (err) {
      // One bad cycle must never end the watch. It is the thing that has to
      // still be running tomorrow.
      say(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, IDLE_MS));
  }
}

await main();
