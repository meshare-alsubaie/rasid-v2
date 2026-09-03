/**
 * The scheduler, against the two ways it can ruin the project.
 *
 * It can read too much, and the home address that reads 9 of 10 sources where a
 * data centre reads 7 gets blocked. Or it can read too little of something, and
 * a window opens and closes inside a gap nobody notices, which is the failure
 * this application exists to prevent.
 *
 * Most of what follows is a simulation over a simulated day rather than an
 * assertion about one function call, because a rate limit that holds for one
 * cycle and not for a day is not a rate limit.
 *
 * It runs against the real dataset, not a fixture. Two defects here were found
 * only because the shape of the real data is nothing like the shape a fixture
 * would have: 189 of 423 sources belong to S or A tier organisations, and one
 * host carries 24 sources on its own.
 *
 *   npm run test:schedule
 */
import { readFileSync } from "node:fs";
import {
  FIRST_SWEEP_MINUTES,
  HOST_GAP_MINUTES,
  INTERVAL_MINUTES,
  clampAfterSleep,
  dueNow,
  hostCounts,
  initialSpread,
  intervalMinutes,
  markChecked,
  reconcile,
  tierOf,
  type Due,
  type Tier,
} from "../src/pipeline/schedule";
import type { Opportunity, Organisation } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const T0 = Date.parse("2026-09-01T06:00:00.000Z");
const MIN = 60_000;
const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

const orgs = read<Organisation>("data/organisations.json");
const opportunities = read<Opportunity>("data/opportunities.json");

const targets: { sourceUrl: string; orgId: string; tier: Tier }[] = [];
for (const o of orgs) {
  for (const s of o.sources) {
    if (s.verifiedAtISO === null) continue;
    targets.push({
      sourceUrl: s.url,
      orgId: o.id,
      tier: tierOf(s.url, o, s.type, s.coopConfirmed === true, opportunities, T0),
    });
  }
}
const HOSTS = hostCounts(targets.map((t) => t.sourceUrl));
const OLD_DAILY = targets.length * 4; // the four-round schedule this replaces

console.log(`the real dataset: ${targets.length} sources across ${HOSTS.size} hosts`);
{
  const mix = targets.reduce<Record<string, number>>((a, t) => {
    a[t.tier] = (a[t.tier] ?? 0) + 1;
    return a;
  }, {});
  console.log(`  tiers: ${Object.entries(mix).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  check(
    "the fast tier is a minority of the dataset, or it is not a tier",
    (mix.hot ?? 0) + (mix.high ?? 0) < targets.length / 2,
    `${(mix.hot ?? 0) + (mix.high ?? 0)} of ${targets.length}`,
  );
}

console.log("\nintervals only ever get longer down the tiers");
check(
  "hot < high < medium < low",
  INTERVAL_MINUTES.hot < INTERVAL_MINUTES.high &&
    INTERVAL_MINUTES.high < INTERVAL_MINUTES.medium &&
    INTERVAL_MINUTES.medium < INTERVAL_MINUTES.low,
);
check(
  "a host carrying many sources slows each of them down",
  intervalMinutes("https://alinma.com/x", "high", new Map([["alinma.com", 24]])) ===
    24 * HOST_GAP_MINUTES,
  `${intervalMinutes("https://alinma.com/x", "high", new Map([["alinma.com", 24]]))}m`,
);
check(
  "and a host with one source is not slowed at all",
  intervalMinutes("https://solo.gov.sa/x", "high", new Map([["solo.gov.sa", 1]])) ===
    INTERVAL_MINUTES.high,
);

console.log("\nthe first sweep finishes while the owner is still at the machine");
{
  const state = reconcile([], targets, T0, HOSTS);
  const latest = Math.max(...state.map((d) => d.nextCheckAt));
  check(
    "every source is scheduled inside the first-sweep window",
    latest <= T0 + FIRST_SWEEP_MINUTES * MIN,
    `latest at +${Math.round((latest - T0) / MIN)}m of ${FIRST_SWEEP_MINUTES}m`,
  );
  /*
   * Being scheduled is not being read. A host carrying 24 sources cannot be
   * swept in thirty minutes without taking a request every seventy-five
   * seconds, so the host floor holds some of them back - which is the correct
   * behaviour and is asserted below rather than papered over here.
   */
  check(
    "and not all in the same minute",
    new Set(state.map((d) => Math.floor(d.nextCheckAt / MIN))).size > 20,
  );
  check(
    "the spread survives a restart, so a restart is not a new burst",
    initialSpread("https://a.gov.sa/x", 30) === initialSpread("https://a.gov.sa/x", 30),
  );
}

/*
 * The invariant that stands between this project and a blocked address.
 *
 * PLAN.md first promised "under twice the old daily traffic", and that promise
 * was wrong - not too strict, but measuring the wrong thing. No server ever
 * experiences the global total; each one experiences only its own rate, and the
 * global number is blind to the case that actually bites: one host carrying two
 * dozen sources, which the old flat schedule hit 96 times a day in four bursts
 * and a naive per-source interval would have hit a thousand times.
 *
 * So the hard assertion is per host, at a value with a reason behind it, and
 * the global total is checked only for self-consistency against what the
 * intervals promise - which catches double-reads and drift without inventing a
 * threshold to sit under.
 */
console.log("\nover a simulated day, no host is leaned on harder than the budget allows");
{
  let state = reconcile([], targets, T0, HOSTS);
  const reads = new Map<string, number[]>();
  const perHost = new Map<string, number>();
  const hostReads = new Map<string, number[]>();
  const MAX_PER_CYCLE = 40;

  for (let t = T0; t < T0 + 24 * 60 * MIN; t += MIN) {
    const due = dueNow(state, t, MAX_PER_CYCLE, HOSTS);
    if (due.length === 0) continue;
    const urls = new Set(due.map((d) => d.sourceUrl));
    for (const d of due) {
      reads.set(d.sourceUrl, [...(reads.get(d.sourceUrl) ?? []), t]);
      const host = new URL(d.sourceUrl).host;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      hostReads.set(host, [...(hostReads.get(host) ?? []), t]);
    }
    state = state.map((d) => (urls.has(d.sourceUrl) ? markChecked(d, t, HOSTS) : d));
  }

  /*
   * Asserted as the shortest gap between two reads of one host, not as a count
   * per day. A daily count is off by one at the boundary - a source read at
   * minute zero and then every twelve minutes lands 121 times in 1440 minutes,
   * which fails a ceiling of 120 while behaving perfectly. The gap is the thing
   * the server actually experiences, and it has no boundary to be wrong about.
   */
  let tightestHostGap = Infinity;
  let tightestHost = "";
  for (const [h, times] of hostReads) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const gap = (times[i]! - times[i - 1]!) / MIN;
      if (gap < tightestHostGap) [tightestHostGap, tightestHost] = [gap, h];
    }
  }
  check(
    `no host is read twice inside ${HOST_GAP_MINUTES} minutes`,
    tightestHostGap >= HOST_GAP_MINUTES,
    `tightest was ${tightestHost} at ${tightestHostGap}m`,
  );
  let worstHost = "";
  let worstN = 0;
  for (const [h, n] of perHost) if (n > worstN) [worstHost, worstN] = [h, n];
  console.log(`  busiest host: ${worstHost} at ${worstN} reads/day`);

  let tooFast = 0;
  let worst = "";
  for (const d of state) {
    const times = reads.get(d.sourceUrl) ?? [];
    const own = intervalMinutes(d.sourceUrl, d.tier, HOSTS) * MIN;
    for (let i = 1; i < times.length; i++) {
      if (times[i]! - times[i - 1]! < own) {
        tooFast++;
        worst = `${d.sourceUrl} twice in ${(times[i]! - times[i - 1]!) / MIN}m`;
      }
    }
  }
  check("and no source is re-read inside its own interval", tooFast === 0, worst);

  const totalReads = [...reads.values()].reduce((n, a) => n + a.length, 0);
  const promised = targets.reduce(
    (n, t) => n + 1440 / intervalMinutes(t.sourceUrl, t.tier, HOSTS),
    0,
  );
  check(
    "the day's traffic matches what the intervals promise, with no drift",
    totalReads <= Math.ceil(promised * 1.05),
    `${totalReads} reads vs ${Math.round(promised)} promised`,
  );
  console.log(
    `  note: ${totalReads} reads/day against the old schedule's ${OLD_DAILY}. Higher on purpose,` +
      ` and spread: the old one arrived in four bursts.`,
  );

  console.log("\nand nothing is starved, which is the other way to fail");
  const never = state.filter((d) => (reads.get(d.sourceUrl) ?? []).length === 0);
  check("every source was read at least once in the day", never.length === 0, `${never.length} unread`);

  const lowReads = state
    .filter((d) => d.tier === "low")
    .map((d) => (reads.get(d.sourceUrl) ?? []).length);
  if (lowReads.length > 0) {
    check(
      "the long low-tier tail is not starved by the fast tiers",
      Math.min(...lowReads) >= 3,
      `least-read low source got ${Math.min(...lowReads)}`,
    );
  }
}

console.log("\nan open window is read four times an hour, host budget permitting");
{
  const hot: Due[] = [
    { sourceUrl: "https://solo.gov.sa/coop", orgId: "x", tier: "hot", nextCheckAt: T0, lastCheckedAt: null },
  ];
  const solo = new Map([["solo.gov.sa", 1]]);
  let s = hot;
  let n = 0;
  for (let t = T0; t < T0 + 24 * 60 * MIN; t += MIN) {
    if (dueNow(s, t, 10, solo).length === 0) continue;
    n++;
    s = s.map((d) => markChecked(d, t, solo));
  }
  check("96 reads a day on a host of its own", n >= 90, `${n} reads`);
}

console.log("\nwaking from sleep is not a stampede");
{
  const state = reconcile([], targets, T0, HOSTS).map((d) => markChecked(d, T0, HOSTS));
  const woke = T0 + 10 * 60 * MIN;
  /*
   * Counted as "how many sources believe they are overdue", not as what dueNow
   * hands back. dueNow already caps the damage at one source per host, so
   * reading its output here would measure that guard a second time and say
   * nothing about the backlog itself - which is the thing clamping exists to
   * flatten.
   */
  const overdue = (s: Due[]): number => s.filter((d) => d.nextCheckAt <= woke).length;
  const naive = overdue(state);
  const clamped = overdue(clampAfterSleep(state, woke));
  check("without clamping, every source is overdue at once", naive === state.length, `${naive}`);
  check("clamping defers the backlog instead", clamped < naive / 4, `${clamped} still overdue`);
  check(
    "and nothing is deferred past the first-sweep window, which would hide it",
    clampAfterSleep(state, woke).every((d) => d.nextCheckAt <= woke + FIRST_SWEEP_MINUTES * MIN),
  );
  check(
    "an ordinary busy cycle is not mistaken for a sleep",
    clampAfterSleep(state, T0 + 20 * MIN).every(
      (d, i) => d.nextCheckAt === state[i]!.nextCheckAt,
    ),
  );
}

console.log("\na window that just opened is re-timed, not left on its old interval");
{
  const before: Due[] = [
    {
      sourceUrl: "https://solo.gov.sa/coop",
      orgId: "x",
      tier: "low",
      nextCheckAt: T0 + 300 * MIN,
      lastCheckedAt: T0 - 40 * MIN,
    },
  ];
  const solo = new Map([["solo.gov.sa", 1]]);
  const after = reconcile(before, [{ sourceUrl: "https://solo.gov.sa/coop", orgId: "x", tier: "hot" }], T0, solo);
  check("it moves to the hot tier", after[0]!.tier === "hot");
  check(
    "and is due one hot interval after its last read, not its old one",
    after[0]!.nextCheckAt === T0 - 40 * MIN + INTERVAL_MINUTES.hot * MIN,
  );
}

console.log("\nthe tier is read from the page and the calendar, never remembered");
{
  const cOrg = { id: "x", tier: "C" } as unknown as Organisation;
  const sOrg = { id: "y", tier: "S" } as unknown as Organisation;
  const url = "https://x.gov.sa/p";
  const closingIn3: Opportunity = {
    sourceUrl: url,
    status: "unknown",
    closesISO: new Date(T0 + 3 * 24 * 60 * MIN).toISOString(),
  } as unknown as Opportunity;

  check("a confirmed co-op page is high whoever owns it", tierOf(url, cOrg, "site_root", true, [], T0) === "high");
  check("a careers page of a serious employer is high", tierOf(url, sOrg, "careers_page", false, [], T0) === "high");
  check("the same page under a C-tier owner is medium", tierOf(url, cOrg, "careers_page", false, [], T0) === "medium");
  check("a site root is low, however famous its owner", tierOf(url, sOrg, "site_root", false, [], T0) === "low");
  check("a deadline three days out overrides all of it", tierOf(url, cOrg, "site_root", false, [closingIn3], T0) === "hot");
  check(
    "and the same deadline ten days later does not",
    tierOf(url, cOrg, "site_root", false, [closingIn3], T0 + 10 * 24 * 60 * MIN) === "low",
  );
}

console.log("\nsources that left the dataset leave the schedule");
{
  const before = reconcile([], targets, T0, HOSTS);
  const after = reconcile(before, targets.slice(0, 10), T0, HOSTS);
  check("the schedule shrinks with the dataset", after.length === 10, `${after.length}`);
}

console.log("\na lost schedule file does not lose the host floor");
{
  /*
   * The crash case. `.rasid/schedule.json` is per-machine and gitignored, so a
   * rebuild starts with every `lastCheckedAt` null — and the host floor keeps
   * its entire memory in exactly that field. Without a seed, a host read sixty
   * seconds before the crash is eligible the moment the watcher comes back, and
   * the least steady moment on the machine becomes the hardest one on the site.
   */
  const two = [
    { sourceUrl: "https://one.gov.sa/coop", orgId: "one", tier: "high" as const },
    { sourceUrl: "https://one.gov.sa/news", orgId: "one", tier: "high" as const },
  ];
  const hosts = new Map([["one.gov.sa", 2]]);
  const aMinuteAgo = T0 - 60_000;
  const seed = new Map(two.map((t) => [t.sourceUrl, aMinuteAgo]));

  const blind = reconcile([], two, T0, hosts);
  check(
    "without a seed the rebuilt schedule remembers nothing",
    blind.every((d) => d.lastCheckedAt === null),
  );
  check(
    "and the floor lets a host through that answered a minute ago",
    dueNow(
      blind.map((d) => ({ ...d, nextCheckAt: T0 - 1 })),
      T0,
      10,
      hosts,
    ).length === 1,
  );

  const seeded = reconcile([], two, T0, hosts, seed);
  check("with the seed it remembers the last attempt", seeded.every((d) => d.lastCheckedAt === aMinuteAgo));
  check(
    "and the host floor holds",
    dueNow(
      seeded.map((d) => ({ ...d, nextCheckAt: T0 - 1 })),
      T0,
      10,
      hosts,
    ).length === 0,
  );

  const future = new Map(two.map((t) => [t.sourceUrl, T0 + 60 * MIN]));
  check(
    "a seed from the future is refused, so a bad clock cannot silence a source",
    reconcile([], two, T0, hosts, future).every((d) => d.lastCheckedAt === null),
  );
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
