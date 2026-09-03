/**
 * The dataset is the backend.
 *
 * Everything the interface knows comes from the JSON the pipeline commits, so
 * a data-only commit republishes the site without a rebuild. Nothing here
 * invents a value: where the pipeline stored null, this layer keeps null, and
 * the rendering decides how to say "not announced".
 */
import { endOfDeadline, statusFor } from "../types";
import type {
  AggregatorSource,
  Opportunity,
  Organisation,
  SourceHealth,
} from "../types";

/**
 * Whether the phone is actually receiving, as of the last send.
 *
 * Written by the notifier. It exists because the failure it reports is
 * completely invisible from here otherwise: a push subscription can be thrown
 * away by the browser at any time, every later send then fails with HTTP 410,
 * and the app has no way to know — it went on showing a calm home screen for
 * forty-seven hours while nothing at all was reaching the phone.
 */
export interface NotifyHealth {
  lastAttemptISO: string | null;
  lastSuccessISO: string | null;
  state: "healthy" | "down";
  reason: string;
  heldCount: number;
}

/**
 * Whose fit the relevance scores describe.
 *
 * Every score in the dataset is computed against one stored profile, and the
 * interface used to present them as if they were properties of the announcement.
 * For the person who wrote the profile that is terse; for anyone he shares the
 * link with it is simply wrong, and nothing on the screen said otherwise.
 */
export interface ScoreBasis {
  fieldLabel: string | null;
  computedISO: string | null;
}

export interface Dataset {
  orgs: Organisation[];
  aggregators: AggregatorSource[];
  opportunities: Opportunity[];
  health: SourceHealth[];
  orgById: Map<string, Organisation>;
  /** Worst health state across an organisation's sources. */
  healthOf: (orgId: string) => SourceHealth["state"] | "unwatched";
  lastCheckISO: string | null;
  /** Null when the file is not there yet, which is not itself a problem. */
  notifyHealth: NotifyHealth | null;
  /** Null before the first round writes it. */
  scoreBasis: ScoreBasis | null;
}

const base = import.meta.env.BASE_URL;

async function load<T>(name: string): Promise<T[]> {
  const res = await fetch(`${base}data/${name}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`تعذّر تحميل ${name}.json (${res.status})`);
  return (await res.json()) as T[];
}

const WORST: Record<SourceHealth["state"], number> = { healthy: 0, degraded: 1, broken: 2 };

/**
 * A single object rather than a list, and its absence is not a failure.
 *
 * The file appears the first time the notifier runs. A deployment that predates
 * it, or a fresh clone, simply has no opinion about the channel yet — which is
 * different from the channel being down, and must not be rendered as though it
 * were.
 */
async function loadOptional<T>(name: string): Promise<T | null> {
  try {
    const res = await fetch(`${base}data/${name}.json`, { cache: "no-cache" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loadDataset(): Promise<Dataset> {
  const [orgs, aggregators, opportunities, health, notifyHealth, scoreBasis] = await Promise.all([
    load<Organisation>("organisations"),
    load<AggregatorSource>("aggregators"),
    load<Opportunity>("opportunities"),
    load<SourceHealth>("health"),
    loadOptional<NotifyHealth>("notify-health"),
    loadOptional<ScoreBasis>("score-basis"),
  ]);

  /*
   * The stored status is treated as a cache and recomputed on every load.
   *
   * The collector does this too, but the collector runs every six hours and the
   * calendar does not wait for it — a window can open at midnight and be read
   * at seven in the morning. Anything that depends on the clock has to be
   * derived when it is read, or the app spends the gap asserting yesterday's
   * answer. The dates are what was published; the status is only a view of them.
   */
  const now = Date.now();
  const live = opportunities.map((o) => {
    const status = statusFor(o, now);
    if (status === o.status) return o;
    const flags = new Set(o.flags);
    if (status === "closing_soon") flags.add("closing_in_48h");
    else flags.delete("closing_in_48h");
    return { ...o, status, flags: [...flags] };
  });

  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const byOrg = new Map<string, SourceHealth[]>();
  for (const h of health) {
    const list = byOrg.get(h.orgId);
    if (list) list.push(h);
    else byOrg.set(h.orgId, [h]);
  }

  const lastCheckISO =
    health.length === 0
      ? null
      : health.reduce((a, b) => (a.lastAttemptISO > b.lastAttemptISO ? a : b)).lastAttemptISO;

  return {
    orgs,
    aggregators,
    opportunities: live,
    health,
    orgById,
    /*
     * The worst state across everything the organisation is *configured* to be
     * watched on — not across whatever happened to get fetched.
     *
     * "unwatched" is its own answer, distinct from healthy, and it now covers
     * the case that actually bit: an organisation with seven verified sources
     * of which one was ever fetched used to report the health of that one. The
     * Season Bar drew it as "؟", whose legend reads "المصدر يُقرأ" — the source
     * is being read — for six pages nobody had opened. An audit found 33
     * organisations in that state and 334 sources of 413 never attempted. A
     * source nobody has fetched cannot make an organisation healthy, so a
     * partially-read organisation is degraded and a wholly-unread one is
     * unwatched.
     */
    healthOf: (orgId) => {
      const configured = (orgById.get(orgId)?.sources ?? []).filter(
        (s) => s.verifiedAtISO !== null,
      );
      const list = byOrg.get(orgId) ?? [];
      const everRead = new Set(list.filter((h) => h.lastSuccessISO !== null).map((h) => h.sourceUrl));
      if (configured.length === 0 || everRead.size === 0) return "unwatched";

      const worst = list.reduce(
        (w, h) => (WORST[h.state] > WORST[w] ? h.state : w),
        "healthy" as SourceHealth["state"],
      );
      const unread = configured.filter((s) => !everRead.has(s.url)).length;
      return unread > 0 && worst === "healthy" ? "degraded" : worst;
    },
    lastCheckISO,
    notifyHealth,
    scoreBasis,
  };
}

/* ---------- small shared formatters ---------- */

const AR_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

export function formatDate(iso: string | null): string {
  if (iso === null) return "لم يُعلن";
  const d = new Date(iso);
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "قبل ٤ ساعات". Deliberately coarse: precision we do not have is a lie. */
export function timeAgo(iso: string | null): string {
  if (iso === null) return "لم يُفحص بعد";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 2) return "الآن";
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${hours} ساعة`;
  const days = Math.round(hours / 24);
  return `قبل ${days} يوم`;
}

/*
 * Measured to the end of the published day in Riyadh, not to midnight UTC.
 * Counting to the raw parse made a deadline read "بعد 0 يوم" from three in the
 * morning on its final day, and negative for the rest of it.
 */
export const daysUntil = (iso: string | null): number | null =>
  iso === null ? null : Math.ceil((endOfDeadline(iso) - Date.now()) / 86_400_000);
