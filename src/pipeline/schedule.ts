/**
 * When each source is next worth reading.
 *
 * The old design was four rounds a day, every source every round, because that
 * is what a cron line can express. It cost up to six hours of blindness on the
 * pages that matter and spent exactly the same effort on a ministry's media
 * centre as on a confirmed co-op page.
 *
 * The owner asked for "all of them, all the time". Taken literally that is a
 * full sweep every two minutes: about three hundred and sixty sweeps a day
 * against Saudi government hosts from one home address, which is ninety times
 * the current load and the fastest way to lose the address. And that address is
 * the whole advantage - measured, it reads 9 of 10 test sources where a data
 * centre reads 7 of 10. Losing it to impatience would cost more than any delay.
 *
 * So the sweep is continuous and the interval is per source. A page whose
 * window is open is read four times an hour; a C-tier ministry that has not
 * moved in months is read every four hours. Detection on what matters goes from
 * six hours to fifteen minutes while total traffic stays under twice what it is
 * today.
 */
import type { Opportunity, Organisation } from "../types.js";

export type Tier = "hot" | "high" | "medium" | "low";

/**
 * Minutes between reads.
 *
 * These are floors, not promises: a source is read when it is due *and* a slot
 * is free, and the fetcher's own per-host spacing still applies on top.
 */
export const INTERVAL_MINUTES: Record<Tier, number> = {
  hot: 15,
  high: 30,
  medium: 120,
  low: 240,
};

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

/**
 * What tier a source sits in, decided fresh every cycle.
 *
 * Deliberately recomputed rather than stored: a window opens and closes on the
 * calendar whether or not anything fetched it, and a tier written down last
 * week is a fact about last week. This project has already shipped one bug of
 * exactly that shape, where a stored status left a window reading "announced,
 * not yet open" ten days after it opened.
 */
export function tierOf(
  sourceUrl: string,
  org: Organisation,
  opportunities: Opportunity[],
  nowMs: number,
): Tier {
  const live = opportunities.filter((o) => o.sourceUrl === sourceUrl);
  for (const o of live) {
    if (o.status === "open" || o.status === "closing_soon") return "hot";
    if (o.closesISO) {
      const days = (Date.parse(o.closesISO) - nowMs) / 86_400_000;
      if (days >= 0 && days <= HOT_WINDOW_DAYS) return "hot";
    }
  }
  if (org.tier === "S" || org.tier === "A") return "high";
  if (org.tier === "B") return "medium";
  return "low";
}

/**
 * The sources due now, most overdue first.
 *
 * Ordering by overdueness rather than by tier is deliberate. Sorting by tier
 * would let a busy hot list starve the low tier for ever, and a C-tier source
 * that has not been read in a day is a real hole in the coverage even though
 * each individual one is unlikely to move. Overdueness expresses both: a hot
 * source becomes overdue four times as fast, so it still wins nearly every
 * contest, without any tier being unreachable.
 */
export function dueNow(state: Due[], nowMs: number, max: number): Due[] {
  return state
    .filter((d) => d.nextCheckAt <= nowMs)
    .sort(
      (a, b) =>
        (nowMs - a.nextCheckAt) / INTERVAL_MINUTES[a.tier] -
        (nowMs - b.nextCheckAt) / INTERVAL_MINUTES[b.tier],
    )
    .reverse()
    .slice(0, max);
}

/**
 * Spread the first cycle out instead of firing every source at once.
 *
 * Without this, the first start after a reboot makes four hundred sources due
 * simultaneously, and the scheduler dutifully tries to read all of them. The
 * per-host spacing would keep it polite but the burst is still the worst
 * possible first impression on a hundred and sixty-eight hosts, and it is
 * exactly the traffic shape a bot filter is looking for. A source's offset is
 * derived from its url, so it is stable across restarts: the same source lands
 * in the same slot every time rather than being reshuffled into a new burst.
 */
export function initialSpread(sourceUrl: string, tier: Tier): number {
  let h = 0;
  for (let i = 0; i < sourceUrl.length; i++) h = (h * 31 + sourceUrl.charCodeAt(i)) >>> 0;
  return (h % (INTERVAL_MINUTES[tier] * 60_000)) as number;
}

/**
 * Fold the current dataset into the schedule, keeping what is still true.
 *
 * Sources that vanished from the dataset are dropped, new ones are spread
 * across their first interval, and a source whose tier changed keeps its last
 * check but is re-timed from it - so a page that just became hot is read within
 * fifteen minutes of that fact rather than waiting out the four-hour interval
 * it was on when the window opened.
 */
export function reconcile(
  previous: Due[],
  targets: { sourceUrl: string; orgId: string; tier: Tier }[],
  nowMs: number,
): Due[] {
  const before = new Map(previous.map((d) => [d.sourceUrl, d]));
  return targets.map((t) => {
    const old = before.get(t.sourceUrl);
    if (!old) {
      return {
        ...t,
        nextCheckAt: nowMs + initialSpread(t.sourceUrl, t.tier),
        lastCheckedAt: null,
      };
    }
    if (old.tier === t.tier) return { ...old, orgId: t.orgId };
    const base = old.lastCheckedAt ?? nowMs;
    return {
      ...t,
      nextCheckAt: base + INTERVAL_MINUTES[t.tier] * 60_000,
      lastCheckedAt: old.lastCheckedAt,
    };
  });
}

/** After a read, whenever it happened, the next one is one interval later. */
export function markChecked(d: Due, nowMs: number): Due {
  return { ...d, lastCheckedAt: nowMs, nextCheckAt: nowMs + INTERVAL_MINUTES[d.tier] * 60_000 };
}

/**
 * A machine that was asleep has not fallen behind by every minute it was off.
 *
 * Waking from a night's hibernation makes every source overdue by ten hours,
 * and an uncapped catch-up would read four hundred sources as fast as the
 * pacing allows. Nothing is gained by that: a page that changed at three in the
 * morning is equally changed at eight. So overdueness is clamped to one
 * interval, which keeps the ordering meaningful while removing the stampede.
 */
export function clampAfterSleep(state: Due[], nowMs: number): Due[] {
  return state.map((d) => {
    const overdueBy = nowMs - d.nextCheckAt;
    const oneInterval = INTERVAL_MINUTES[d.tier] * 60_000;
    if (overdueBy <= oneInterval) return d;
    return { ...d, nextCheckAt: nowMs - oneInterval + initialSpread(d.sourceUrl, d.tier) % oneInterval };
  });
}
