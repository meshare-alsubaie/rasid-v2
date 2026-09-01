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

  const res = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  if (res.status !== 0 || !res.stdout) return null; // Not knowing is not a reason to pause.
  const running = res.stdout.toLowerCase();
  for (const n of names) {
    if (running.includes(`"${n.toLowerCase()}.exe"`)) return n;
  }
  return null;
}

function loadState(): Due[] {
  if (!existsSync(STATE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Due[];
  } catch {
    // A corrupt schedule is not worth a crash. Rebuilding it costs one spread
    // cycle and nothing else; the dataset itself is untouched by this file.
    say("schedule.json was unreadable and has been rebuilt");
    return [];
  }
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
 * Killing it loses nothing. The pages that were read have already been written,
 * the schedule advances anyway, and whatever was still owed a verdict keeps its
 * pendingClassification and is picked up next time.
 */
const CHILD_TIMEOUT_MS = Number(process.env.RASID_CYCLE_TIMEOUT_MS ?? 12 * 60_000);

function runNode(script: string, extra: string[]): number {
  const res = spawnSync(process.execPath, ["--import", "tsx", script, ...extra], {
    stdio: "inherit",
    env: process.env,
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (res.error && "code" in res.error && res.error.code === "ETIMEDOUT") {
    say(`${script} exceeded ${CHILD_TIMEOUT_MS / 60_000} minutes and was stopped`);
    return 124; // the shell convention for "timed out", so the log is greppable
  }
  return res.status ?? 1;
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
   * The schedule advances even when the collector failed.
   *
   * Leaving a failed source due would make it the most overdue thing in the
   * queue for ever, so a single permanently broken host would be retried every
   * cycle and crowd out everything else. The failure is not lost: collect
   * writes it into health.json as degraded or broken, which is where it
   * belongs and where the application shows it.
   */
  const checkedAt = Date.now();
  const dueUrls = new Set(due.map((d) => d.sourceUrl));
  next = next.map((d) => (dueUrls.has(d.sourceUrl) ? markChecked(d, checkedAt, hosts) : d));

  if (collectExit === 0) {
    const notifyExit = runNode("scripts/notify.ts", []);
    say(`notify exit ${notifyExit}`);
  } else {
    say("collect failed, so nothing was notified this cycle");
  }

  return next;
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
