/**
 * When each source is next worth reading.
 *
 * The old design was four rounds a day, every source every round, because that
 * is what a cron line can express. It cost up to six hours of blindness on the
 * pages that matter and spent exactly the same effort on a ministry's media
 * centre as on a confirmed co-op page.
 *
 * The owner asked for "all of them, all the time". Taken literally that is a
 * full sweep every two minutes against Saudi government hosts from one home
 * address - and that address is the whole advantage. Measured, it reads 9 of 10
 * test sources where a data centre reads 7 of 10, and the project's own history
 * says the same: nine of the eleven failures in the first cloud run were
 * .gov.sa hosts that answer this machine without complaint. Losing it to
 * impatience would cost more than any delay.
 *
 * So the sweep is continuous, the interval is per source, and the budget is per
 * host.
 */
import type { Opportunity, Organisation, SourceType } from "../types.js";

export type Tier = "hot" | "high" | "medium" | "low";

/**
 * Minutes between reads of one source, before the per-host floor is applied.
 *
 * These were first written as 15/30/120/240 against a guess about the shape of
 * the dataset. Measured, the guess was wrong in a way that mattered: 189 of the
 * 423 sources belong to S or A tier organisations, so "prestigious owner" tiers
 * nearly half the dataset as urgent and tiers nothing. What actually predicts
 * an announcement is the kind of page, not the fame of whoever runs it, and
 * that is what `tierOf` uses now.
 */
export const INTERVAL_MINUTES: Record<Tier, number> = {
  hot: 15,
  high: 45,
  medium: 180,
  low: 360,
};

/**
 * The floor that protects a server, and the number that actually matters.
 *
 * Politeness is per host; the schedule is per source; and the two come apart
 * badly. alinma.com carries 24 verified sources. On a flat 30-minute interval
 * that host alone would have taken a request every 75 seconds, all day, from a
 * residential address - which is not a crawler being thorough, it is a crawler
 * being blocked. Aramco, KPMG, SABIC and NCA all carry seven or more.
 *
 * So a host's sources share one budget: each source waits at least
 * `HOST_GAP_MINUTES x (number of sources on that host)`, which pins every host
 * to one read per HOST_GAP_MINUTES no matter how many pages we watch on it. A
 * host with one source is untouched by this and runs at its tier's pace.
 */
export const HOST_GAP_MINUTES = 12;

/** A window closing within this many days makes its source hot. */
export const HOT_WINDOW_DAYS = 7;

export interface Due {
  sourceUrl: string;
  orgId: string;
  tier: Tier;
  /** Epoch ms. Never read before this. */
  nextCheckAt: number;
  lastCheckedAt: number | null;
}

/** How many sources this run watches on each host. */
export function hostCounts(urls: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const u of new Set(urls)) {
    let host: string;
    try {
      host = new URL(u).host;
    } catch {
      continue;
    }
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return counts;
}

/** The real interval for one source: its tier's pace, slowed to its host's budget. */
export function intervalMinutes(sourceUrl: string, tier: Tier, hosts: Map<string, number>): number {
  let onHost = 1;
  try {
    onHost = hosts.get(new URL(sourceUrl).host) ?? 1;
  } catch {
    onHost = 1;
  }
  return Math.max(INTERVAL_MINUTES[tier], onHost * HOST_GAP_MINUTES);
}

/**
 * What tier a source sits in, decided fresh every cycle.
 *
 * Deliberately recomputed rather than stored: a window opens and closes on the
 * calendar whether or not anything fetched it, and a tier written down last
 * week is a fact about last week. This project has already shipped one bug of
 * exactly that shape, where a stored status left a window reading "announced,
 * not yet open" ten days after it opened.
 *
 * The ordering below is the whole design in five lines. A page that has told us
 * it carries cooperative training is read fastest; a careers page of a serious
 * employer next; an announcement page after that; and a site root - a home page
 * watched only because an announcement might appear on it - last. Site roots
 * and media centres move every day and almost never with news we want, which is
 * exactly why they must not set the pace.
 */
export function tierOf(
  sourceUrl: string,
  org: Organisation,
  sourceType: SourceType,
  coopConfirmed: boolean,
  opportunities: Opportunity[],
  nowMs: number,
): Tier {
  for (const o of opportunities) {
    if (o.sourceUrl !== sourceUrl) continue;
    if (o.status === "open" || o.status === "closing_soon") return "hot";
    if (o.closesISO) {
      const days = (Date.parse(o.closesISO) - nowMs) / 86_400_000;
      if (days >= 0 && days <= HOT_WINDOW_DAYS) return "hot";
    }
  }
  if (coopConfirmed) return "high";
  if (sourceType === "careers_page" || sourceType === "portal") {
    return org.tier === "S" || org.tier === "A" ? "high" : "medium";
  }
  if (sourceType === "announcement_page") return "medium";
  return "low";
}

/**
 * The sources due now, most overdue first.
 *
 * Ordering by overdueness relative to interval rather than by tier is
 * deliberate. Sorting by tier would let a busy hot list starve the low tier for
 * ever, and a site root that has not been read in a day is a real hole in the
 * coverage even though each one is unlikely to move. Relative overdueness
 * expresses both: a hot source becomes overdue four times as fast, so it wins
 * nearly every contest, without any tier ever becoming unreachable.
 */
export function dueNow(state: Due[], nowMs: number, max: number, hosts: Map<string, number>): Due[] {
  /*
   * The host floor is enforced here, at selection, and not only by the
   * intervals.
   *
   * Slowing each source to its host's share gives the right average rate and
   * says nothing about phase: two sources on one host, due at the same minute,
   * were both selected and the host took two requests at once. The gate caught
   * alinma.com being read twice in the same minute. Phase cannot be fixed by
   * arithmetic either, because sources on one host can sit in different tiers
   * and therefore drift apart at different rates.
   *
   * So the rule is applied where it is actually decidable: a host that was read
   * within HOST_GAP_MINUTES is not eligible, and no cycle takes two sources
   * from the same host. Nothing is lost by waiting - the source stays due and
   * wins the next contest on urgency.
   */
  const lastByHost = new Map<string, number>();
  for (const d of state) {
    if (d.lastCheckedAt === null) continue;
    let host: string;
    try {
      host = new URL(d.sourceUrl).host;
    } catch {
      continue;
    }
    lastByHost.set(host, Math.max(lastByHost.get(host) ?? 0, d.lastCheckedAt));
  }

  const floorMs = HOST_GAP_MINUTES * 60_000;
  const takenThisCycle = new Set<string>();
  const out: Due[] = [];

  for (const { d } of state
    .filter((d) => d.nextCheckAt <= nowMs)
    .map((d) => ({ d, urgency: (nowMs - d.nextCheckAt) / intervalMinutes(d.sourceUrl, d.tier, hosts) }))
    .sort((a, b) => b.urgency - a.urgency)) {
    if (out.length >= max) break;
    let host: string;
    try {
      host = new URL(d.sourceUrl).host;
    } catch {
      host = d.sourceUrl;
    }
    if (takenThisCycle.has(host)) continue;
    const last = lastByHost.get(host);
    if (last !== undefined && nowMs - last < floorMs) continue;
    takenThisCycle.add(host);
    out.push(d);
  }
  return out;
}

/**
 * The first sweep is compressed, because the first sweep is the one that has
 * nothing behind it.
 *
 * Spreading a new source across its own interval is right in steady state and
 * wrong on a cold start: a low-tier source would wait up to six hours to be
 * read for the first time, so a fresh install spends most of a day with an
 * incomplete picture and no way to tell an unread source from a quiet one.
 * Thirty minutes is long enough to stay polite across 140 hosts and short
 * enough that the first complete picture arrives while the owner is still at
 * the machine.
 */
export const FIRST_SWEEP_MINUTES = 30;

/**
 * A stable, evenly spread offset for a source's first read.
 *
 * Derived from the url so it survives restarts: the same source lands in the
 * same slot every time rather than being reshuffled into a new burst every time
 * the watcher starts.
 */
export function initialSpread(sourceUrl: string, windowMinutes: number): number {
  let h = 0;
  for (let i = 0; i < sourceUrl.length; i++) h = (h * 31 + sourceUrl.charCodeAt(i)) >>> 0;
  return h % Math.max(1, Math.round(windowMinutes * 60_000));
}

/**
 * Fold the current dataset into the schedule, keeping what is still true.
 *
 * Sources that vanished from the dataset are dropped, new ones are spread
 * across the first sweep, and a source whose tier changed keeps its last check
 * but is re-timed from it - so a page that just became hot is read within
 * fifteen minutes of that fact rather than waiting out the six-hour interval it
 * was on when the window opened.
 */
/**
 * One url, one entry, whatever the dataset says.
 *
 * `nca.gov.sa/ar/news/` is listed by two organisations, nca and ncac, and both
 * entries are legitimate: it really is the news page for both, and merging the
 * two records is a decision for the owner and not for a scheduler. But fetching
 * it twice is not a decision, it is waste - the snapshot is keyed by url, so
 * the second read only ever overwrote the first, and the host was hit twice for
 * one page. The old collector did this too.
 *
 * The faster tier wins, so deduplication can only ever make a page more
 * watched, never less. The org id kept is the first seen, which affects nothing
 * downstream: health and snapshots are keyed by url.
 */
export function dedupeTargets(
  targets: { sourceUrl: string; orgId: string; tier: Tier }[],
): { sourceUrl: string; orgId: string; tier: Tier }[] {
  const rank: Record<Tier, number> = { hot: 0, high: 1, medium: 2, low: 3 };
  const byUrl = new Map<string, { sourceUrl: string; orgId: string; tier: Tier }>();
  for (const t of targets) {
    const seen = byUrl.get(t.sourceUrl);
    if (!seen || rank[t.tier] < rank[seen.tier]) byUrl.set(t.sourceUrl, t);
  }
  return [...byUrl.values()];
}

export function reconcile(
  previous: Due[],
  targets: { sourceUrl: string; orgId: string; tier: Tier }[],
  nowMs: number,
  hosts: Map<string, number>,
  /**
   * When each source was last actually read, from a record that outlives the
   * schedule file.
   *
   * The host floor's whole memory lived in `.rasid/schedule.json`, which is
   * per-machine, gitignored and rebuilt from nothing after a crash. Rebuilt,
   * every `lastCheckedAt` is null, `lastByHost` is empty, and a host read sixty
   * seconds ago is eligible again — so the one moment the machine is least
   * steady is the moment it hits every site hardest. `data/health.json` records
   * the last attempt per source and survives all of that, so it seeds the
   * politeness the schedule file forgot.
   */
  lastRead?: Map<string, number>,
): Due[] {
  const before = new Map(previous.map((d) => [d.sourceUrl, d]));
  return dedupeTargets(targets).map((t) => {
    const old = before.get(t.sourceUrl);
    if (!old) {
      const seeded = lastRead?.get(t.sourceUrl) ?? null;
      return {
        ...t,
        nextCheckAt: nowMs + initialSpread(t.sourceUrl, FIRST_SWEEP_MINUTES),
        // Only backwards: a stale record must never push a check into the
        // future, it only stops a host being hammered the second it is known
        // to have just answered.
        lastCheckedAt: seeded !== null && seeded <= nowMs ? seeded : null,
      };
    }
    if (old.tier === t.tier) return { ...old, orgId: t.orgId };
    const base = old.lastCheckedAt ?? nowMs;
    return {
      ...t,
      nextCheckAt: base + intervalMinutes(t.sourceUrl, t.tier, hosts) * 60_000,
      lastCheckedAt: old.lastCheckedAt,
    };
  });
}

/** After a read, whenever it happened, the next one is one interval later. */
export function markChecked(d: Due, nowMs: number, hosts: Map<string, number>): Due {
  return {
    ...d,
    lastCheckedAt: nowMs,
    nextCheckAt: nowMs + intervalMinutes(d.sourceUrl, d.tier, hosts) * 60_000,
  };
}

/**
 * A machine that was asleep has not fallen behind by every minute it was off.
 *
 * Waking from a night's hibernation makes every source overdue by ten hours,
 * and an uncapped catch-up would try to read all 423 at once. Nothing is gained
 * by that: a page that changed at three in the morning is equally changed at
 * eight, and the burst is exactly the traffic shape a bot filter is looking
 * for.
 *
 * A first version of this only clamped how overdue a source could be, which
 * changed the ordering and nothing else - every source was still due, and the
 * stampede was untouched. The gate caught it. Waking after a long sleep is the
 * same situation as a cold start, so it is treated the same way: everything is
 * re-spread across the first-sweep window, and nothing is deferred beyond it.
 */
export function clampAfterSleep(state: Due[], nowMs: number, maxLagMinutes = 60): Due[] {
  const lagging = state.filter((d) => nowMs - d.nextCheckAt > maxLagMinutes * 60_000);
  if (lagging.length < state.length / 2) return state; // an ordinary busy cycle, not a sleep

  return state.map((d) => {
    if (nowMs - d.nextCheckAt <= maxLagMinutes * 60_000) return d;
    return { ...d, nextCheckAt: nowMs + initialSpread(d.sourceUrl, FIRST_SWEEP_MINUTES) };
  });
}
