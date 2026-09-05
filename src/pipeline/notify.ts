/**
 * Deciding what is worth waking someone for.
 *
 * Kept as a pure function over the old and new datasets so the rules can be
 * read, tested, and argued with in one place, separate from the sending.
 *
 * The bar is spec section 5.4: something has to be *newly* true. A window that
 * was open yesterday and is open today is not news, and an app that says so
 * every six hours teaches its user to swipe the notifications away, which is
 * the same failure as a stale green light wearing a different coat.
 */
import { endOfDeadline, hijriOf } from "../types";
import { announcementKey, UNJUDGED_TITLE } from "./opportunity";
import type { Opportunity, SourceHealth } from "../types";

export type NoticeKind =
  | "new_relevant"
  | "opened"
  | "closing_soon"
  | "few_seats"
  | "source_broken"
  /**
   * The classifier could not judge what was read.
   *
   * A crawler that stops is loud; a classifier that stops was silent, and it is
   * the more dangerous of the two. `decide` skips any record with a null score,
   * so a revoked key or an outage means every changed page becomes unjudgeable
   * and *nothing is ever pushed again* — while every source stays green,
   * because fetching them worked perfectly. The only trace was a small counter
   * on a screen nobody had a reason to open. This is that failure, said aloud.
   */
  | "classifier_down"
  /**
   * A co-op opening whose fit could not be computed, because the page named no
   * specialism at all.
   *
   * `relevanceOf` returns null for that, and rightly: silence about majors is
   * not a statement that his major qualifies, and inventing a number would be
   * the guess this project refuses everywhere else. But `decide` then skipped
   * the record entirely, so **a confirmed co-op page at a tier-S organisation
   * that does not list majors could never notify him**. stc, Aramco, Al Rajhi,
   * the Digital Government Authority and the Ministry of Justice were all in
   * exactly that state, showing a permanent "?" on the screen and sending
   * nothing.
   *
   * That is the failure criterion itself: an opening published at one of the
   * 127 that does not reach his phone. So it is announced under its own kind,
   * which says in the title that the fit is unknown - he is told, and he is not
   * told a number nobody computed.
   */
  | "fit_unknown";

export interface Notice {
  /** Stable across runs, so the log can prove a thing was said only once. */
  key: string;
  kind: NoticeKind;
  title: string;
  body: string;
  /** Higher goes out first when the daily cap bites. */
  weight: number;
}

export interface NoticeLogEntry {
  key: string;
  sentISO: string;
  /**
   * Which channel carried it. The cap below is six *pushes*, so a digest entry
   * must not eat the budget — before this field existed, one quiet night with
   * nine emailed items left no room to push anything the following day.
   * Absent on entries written before the distinction existed; those are counted
   * as pushes, which is the cautious reading.
   */
  /*
   * "toast" is recorded but never retires anything. The desktop banner is a
   * convenience for the machine he is sitting at; the phone is what reaches him
   * away from it, so a toast must not be able to mark a notice delivered. It is
   * logged only so the same six are not shown again every single round, which
   * is what happened for as long as the push channel was down: six banners a
   * minute, saying what they had already said.
   */
  via?: "push" | "digest" | "toast";
}

/**
 * Spec 5.4: never more than six pushes in a day. The rest goes to the digest.
 *
 * This now bounds *housekeeping only*: a source that stopped loading, the
 * classifier being down. Those are states of the tool, they read the same an
 * hour later, and six a day is already more than anyone wants.
 */
export const DAILY_PUSH_CAP = 6;

/**
 * The separate, much larger budget for actual openings.
 *
 * **This is a deliberate departure from spec 5.4, and it resolves a
 * contradiction between two of the owner's own rules rather than quietly
 * ignoring one.**
 *
 * Spec 5.4 caps every push at six a day. The failure criterion says: an
 * announcement published at any of the 127 that does not reach his phone within
 * six hours is a failure, whatever the gates say. When more than six relevant
 * things happen in one day those two rules cannot both hold, and until now the
 * cap won silently.
 *
 * It was measured, not theorised. On 2026-09-03 thirteen notices were generated;
 * six went out at 07:00 Riyadh and **seven real openings sat in the queue, every
 * one already past the six-hour promise**, waiting for the next day's release.
 * Among them: البنك الأهلي السعودي, هيئة السوق المالية, هيئة الحكومة الرقمية,
 * وزارة الاتصالات وتقنية المعلومات, البنك السعودي للاستثمار.
 *
 * The cap exists to prevent notification fatigue, which is a real cost. A missed
 * semester is a larger one, and he said so in the only sentence in this project
 * that calls itself the single measure of failure. So openings get their own
 * budget, sized so that it never binds in a normal season and still bounds a
 * pathological run — a bug that mints four hundred records must not send four
 * hundred pushes.
 *
 * Twenty is roughly three times the busiest day observed. If it ever binds, that
 * is itself worth knowing, and `notify.ts` prints when it does.
 */
export const DAILY_OPPORTUNITY_CAP = 20;

/**
 * What outranks what when only six can go out.
 *
 * These were ad-hoc numbers, and the ordering they produced was backwards in a
 * way that cost exactly what this project exists to protect. A broken source
 * weighed 150 and an opportunity weighed its relevance score, at most 100 — so
 * twelve "this page stopped loading" alarms and one "the classifier is down"
 * filled every slot, and two co-op announcements scoring 95, both an exact match
 * for his major, were ranked below them and pushed into the digest. The digest
 * is email, and email is not configured, so they would have reached him nowhere
 * at all.
 *
 * The ordering that follows is by what missing the notice actually costs him:
 *
 *   a window about to shut      cannot be recovered once it passes
 *   a window that just opened   he can act on today
 *   seats running out           the same window, with less time
 *   a new match                 the thing he asked to be told about
 *   the classifier is blind     he must check by hand until it is fixed
 *   one source stopped loading  one page of a hundred and fifteen, in the app
 *
 * Housekeeping sits at the bottom on purpose. An alarm about the tool is worth
 * saying; it is never worth saying *instead of* an opening.
 */
/**
 * How long the sent log remembers, and how long a record may keep asking.
 *
 * These two exist as a pair because they constrain each other. `decide` now
 * proposes a new-opportunity notice every round and lets the sent log refuse
 * the repeat — which is what recovers a record that reaches a verdict late.
 * But the log is pruned, and a proposal that outlives its own log entry comes
 * back as a fresh notice: the same opening announced again a month later, with
 * nothing wrong-looking anywhere to explain it.
 *
 * So the window in which a record may still be announced is kept strictly
 * shorter than the log's memory. Fourteen days is far longer than the delay
 * this is meant to survive — a round that failed, a budget that ran out, a page
 * that was not readable yet — and a record still unjudged after two weeks means
 * the classifier has been down that long, which raises its own alarm every day.
 */
export const ANNOUNCE_WINDOW_DAYS = 14;
export const LOG_RETENTION_DAYS = 31;

export const BAND = {
  closingSoon: 500,
  opened: 400,
  fewSeats: 300,
  newRelevant: 200,
  fitUnknown: 180,
  classifierDown: 250,
  sourceBroken: 150,
} as const;

/**
 * Which day this happened on, in Riyadh.
 *
 * Slicing the ISO string gives the UTC day, and the rest of this file runs on
 * Riyadh time: quiet hours are Riyadh, deadlines end at the close of the Riyadh
 * day. So the daily push budget was resetting at three in the morning local
 * time — in the middle of the quiet window — and the six notices "sent today"
 * were counted against a day that started while he was asleep and ended at
 * three the following morning. Two different days, one file.
 */
const dayOf = (iso: string): string => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  // en-CA renders as YYYY-MM-DD, which sorts and compares like the ISO prefix
  // this replaces.
  return new Intl.DateTimeFormat("en-CA", { timeZone: QUIET_HOURS_ZONE }).format(new Date(t));
};

/**
 * The body of a notice, as spec 5.4 asks: role, city, seats, days remaining and
 * the Hijri date.
 *
 * It used to be the title and the relevance score, which is the one number a
 * person cannot act on. Every part is dropped when it was not published rather
 * than filled with a plausible default — an alert is the last place to guess.
 */
function details(o: Opportunity): string {
  const parts = [o.titleAr];
  if (o.cities.length > 0) parts.push(o.cities.join("، "));
  if (o.seats !== null) parts.push(`${o.seats} مقعداً`);
  if (o.closesISO !== null) {
    const days = Math.max(0, Math.ceil(hoursUntil(o.closesISO) / 24));
    parts.push(`يغلق بعد ${days} يوم`);
    const hijri = o.closesHijri ?? hijriOf(o.closesISO);
    if (hijri !== null) parts.push(hijri);
  }
  return parts.join(" · ");
}
/* To the end of the published day in Riyadh — see `endOfDeadline`. Measured
 * from midnight UTC instead, the 48-hour alert fired a day early and then went
 * silent through the whole of the final day. */
const hoursUntil = (iso: string): number => (endOfDeadline(iso) - Date.now()) / 3_600_000;

export interface DecideInput {
  before: Opportunity[];
  after: Opportunity[];
  healthBefore: SourceHealth[];
  healthAfter: SourceHealth[];
  nameOf: (orgId: string) => string;
  threshold: number;
}

/** More than this many unjudged pages in one round is an outage, not bad luck. */
export const UNJUDGED_ALARM = 3;

export function decide(input: DecideInput): Notice[] {
  const { before, after, healthBefore, healthAfter, nameOf, threshold } = input;
  const prior = new Map(before.map((o) => [o.id, o]));
  const priorHealth = new Map(healthBefore.map((h) => [h.sourceUrl, h.state]));
  const out: Notice[] = [];

  for (const o of after) {
    const was = prior.get(o.id);
    const org = nameOf(o.orgId);
    const score = o.relevanceScore;

    if (o.flags.includes("wrong_product")) continue;

    /*
     * A co-op opening we could not score is still an opening.
     *
     * This used to `continue` on any null score, on the reasoning that waking
     * someone for a thing we cannot describe is noise. That is right when the
     * page could not be read - and wrong when the page was read perfectly and
     * simply did not list majors, which is how a great many Saudi co-op pages
     * are written. stc's own "Cooperative Training Program" is one.
     *
     * The two are distinguishable: a page that produced a real title and a
     * co-op product was understood; only the *fit* is unknown. Announcing it
     * under its own kind tells him without telling him a number nobody computed.
     * A page that produced nothing usable is still skipped.
     */
    if (score === null) {
      const readable =
        o.product === "coop" &&
        o.titleAr.trim() !== "" &&
        o.titleAr !== UNJUDGED_TITLE &&
        !o.flags.includes("vanished_from_source");
      const daysKnownNull = (Date.now() - Date.parse(o.firstSeenISO)) / 86_400_000;
      if (readable && daysKnownNull <= ANNOUNCE_WINDOW_DAYS) {
        out.push({
          key: `fit:${announcementKey(o)}`,
          kind: "fit_unknown",
          title: `🟡 تدريب تعاوني · ${org}`,
          body: `${o.titleAr} · لم تذكر الصفحة التخصّصات، فلم تُحسب نسبة ملاءمتها لك. افتحها بنفسك.`,
          weight: BAND.fitUnknown,
        });
      }
      continue;
    }

    /*
     * Announce anything worth announcing, every round, and let the sent log
     * decide what has already gone out.
     *
     * This used to ask whether the row was absent last round — and that was the
     * exact failure this project exists to prevent. A page is very often seen
     * before it can be judged: the classifier fails, the round hits its budget,
     * or the text is not readable on the first pass. That sighting stores a
     * record with `relevanceScore: null`, which is rightly skipped above. The
     * next round produces a verdict, but by then the row is no longer new, so
     * no notice was ever emitted. The record sat in the file at 95 with nothing
     * in the queue and nothing in the log.
     *
     * It was not hypothetical. Two co-op announcements scoring 95, both an
     * exact match for his major, were found in precisely that state — never
     * queued, never sent, while a 65 waited in the queue ahead of them.
     *
     * Nothing about "was it new" is trustworthy enough to gate a notification
     * on, because there are as many ways to arrive late as there are ways for a
     * round to go wrong. `split` already refuses any key in the sent log, and
     * that log is the only real answer to "has he been told". So the condition
     * is simply whether it deserves telling; emitting it again next round is
     * free and costs one set lookup, while missing it once costs a semester.
     * This also heals every record that was skipped while the old rule stood.
     */
    const daysKnown = (Date.now() - Date.parse(o.firstSeenISO)) / 86_400_000;
    if (score >= Math.max(60, threshold) && daysKnown <= ANNOUNCE_WINDOW_DAYS) {
      out.push({
        key: `new:${announcementKey(o)}`,
        kind: "new_relevant",
        title: `🟢 إعلان جديد · ${org}`,
        body: details(o),
        weight: BAND.newRelevant + score,
      });
    }

    if (was !== undefined && was.status !== "open" && o.status === "open") {
      out.push({
        key: `opened:${announcementKey(o)}`,
        kind: "opened",
        title: `🟢 فتح التقديم · ${org}`,
        body: details(o),
        weight: BAND.opened + score,
      });
    }

    if (o.closesISO !== null && hoursUntil(o.closesISO) <= 48 && hoursUntil(o.closesISO) > 0) {
      out.push({
        key: `closing:${announcementKey(o)}:${dayOf(o.closesISO)}`,
        kind: "closing_soon",
        title: `⏳ يغلق قريباً · ${org}`,
        body: `${o.titleAr} · تبقّى ${Math.ceil(hoursUntil(o.closesISO))} ساعة${o.cities.length > 0 ? ` · ${o.cities.join("، ")}` : ""}${o.seats !== null ? ` · ${o.seats} مقعداً` : ""}`,
        weight: BAND.closingSoon + score,
      });
    }

    if (o.seats !== null && o.seats <= 5 && score >= 70 && was?.seats !== o.seats) {
      out.push({
        key: `seats:${announcementKey(o)}:${o.seats}`,
        kind: "few_seats",
        title: `⚠ مقاعد قليلة · ${org}`,
        body: `${o.titleAr} · ${o.seats} مقاعد`,
        weight: BAND.fewSeats + score,
      });
    }
  }

  // A source we can no longer read is the one alarm that is about us, not
  // about an opening. He asked to rely on this app, so it owes him the moment
  // it stops being able to see.
  for (const h of healthAfter) {
    if (h.state === "broken" && priorHealth.get(h.sourceUrl) !== "broken") {
      out.push({
        key: `broken:${h.sourceUrl}`,
        kind: "source_broken",
        title: `🔴 مصدر توقّف · ${nameOf(h.orgId)}`,
        body: "لم يعد يُقرأ آلياً. افحص الصفحة بنفسك.",
        weight: BAND.sourceBroken,
      });
    }
  }

  /*
   * The alarm for the judge, not the eyes.
   *
   * Counted over the whole run rather than per source, because that is the
   * shape the failure has: a key expires and every page in the round becomes
   * unjudgeable at once. Keyed by the day so a persistent outage says so once
   * each morning instead of four times a day, and so it says it again tomorrow
   * if nobody has fixed it.
   */
  /*
   * A queue is not an outage, and this alarm could not tell them apart.
   *
   * It fired on the count of unjudged records alone, and said "no alerts about
   * new opportunities will arrive until classification returns". On the morning
   * this was written that sentence went to his phone alongside **three real
   * opportunity alerts sent in the same batch** - the classifier was working
   * perfectly and grinding through a backlog somebody had created on purpose by
   * clearing the verdict memory. An alarm that contradicts the notification
   * above it teaches him to disbelieve both.
   *
   * So the alarm now needs evidence of a stall, not merely of a queue: a large
   * backlog *and* not one record gaining a score in this round. And when it does
   * fire it describes what is true rather than predicting a silence it cannot
   * know about.
   */
  const unjudged = after.filter((o) => o.flags.includes("needs_manual_review"));
  const scoredBefore = before.filter((o) => o.relevanceScore !== null).length;
  const scoredAfter = after.filter((o) => o.relevanceScore !== null).length;
  const judgedSomething = scoredAfter > scoredBefore;

  if (unjudged.length >= UNJUDGED_ALARM && !judgedSomething) {
    const day = new Date().toISOString().slice(0, 10);
    out.push({
      key: `classifier:${day}`,
      kind: "classifier_down",
      title: "🟠 التصنيف لم يتقدّم",
      body: `${unjudged.length} صفحة قُرئت ولم يُحكم عليها، ولم تُحكم أي صفحة في هذه الجولة. إن تكرّر هذا غداً فالمصنّف متوقّف: افحص الجهات المهمة بنفسك.`,
      weight: BAND.classifierDown,
    });
  }

  /*
   * Five "a source stopped" alerts are one piece of news, badly told.
   *
   * Each broken source produced its own notice, titled
   * "🔴 مصدر توقّف — <organisation>" with an identical body. On a phone the
   * title is truncated: he woke to five notifications reading "مصدر توقّف..."
   * over the same sentence, unable to tell which organisation any of them was
   * about, and they filled the whole housekeeping budget for the day.
   *
   * The names belong in the body, which is shown in full. Two or fewer stay as
   * they are - naming one organisation in a title is clearer than a list of one.
   */
  const broken = out.filter((n) => n.kind === "source_broken");
  if (broken.length > 2) {
    const names = broken.map((n) => n.title.replace(/^🔴 مصدر توقّف\s*[—·-]\s*/u, "").trim());
    for (const n of broken) out.splice(out.indexOf(n), 1);
    out.push({
      // Keyed by the day and the set, so the same outage is not re-sent every
      // round and a different set of sources is a different piece of news.
      key: `broken:${new Date().toISOString().slice(0, 10)}:${names.slice().sort().join("|")}`,
      kind: "source_broken",
      title: `🔴 ${names.length} مصادر توقّفت`,
      body: `${names.join("، ")} — لم تعد تُقرأ آلياً. افحص صفحاتها بنفسك.`,
      weight: BAND.sourceBroken,
    });
  }

  /*
   * One announcement, one notice, even within a single round.
   *
   * Keying on the announcement rather than the record stops the *same* opening
   * being pushed again tomorrow, because the sent log recognises the key. It
   * does not stop two records for one opening producing two notices in the same
   * pass, and that is the shape the data is actually in: one Al Rajhi programme
   * on five pages, scored between 10 and 95. Five notices, one opening, and the
   * phone taught to ignore them.
   *
   * The strongest survives, because the highest score is the one produced from
   * the page that said the most about the programme.
   */
  const best = new Map<string, Notice>();
  for (const n of out) {
    const seen = best.get(n.key);
    if (seen === undefined || n.weight > seen.weight) best.set(n.key, n);
  }
  return [...best.values()];
}

/**
 * Quiet hours are inclusive of the start hour and exclusive of the end, and are
 * always measured in Riyadh, never in the clock of whatever machine is running.
 *
 * This ran on the process clock first, which meant two different answers for
 * the same moment: the scheduled task on the owner's machine kept Saudi time,
 * while the GitHub runner keeps UTC and shifted the quiet window three hours
 * back — silencing eleven in the morning and pushing at two. The user is in one
 * place, so there is only one right answer, and it does not depend on where the
 * code happens to run.
 */
export const QUIET_HOURS_ZONE = "Asia/Riyadh";

export function hourIn(now: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now),
  );
}

export function inQuietHours(
  now: Date,
  startHour: number,
  endHour: number,
  timeZone: string = QUIET_HOURS_ZONE,
): boolean {
  const h = hourIn(now, timeZone);
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

export interface Split {
  push: Notice[];
  digestOnly: Notice[];
}

/**
 * Everything already sent is dropped, then the cap is applied by weight.
 * What does not fit is not discarded: it goes to the daily email instead.
 */
/**
 * The kinds that are allowed to wake him.
 *
 * Quiet hours exist so the app does not ring at three in the morning for news
 * that will read the same at seven. A window closing inside forty-eight hours
 * is not that news. Holding it costs five hours of a deadline that has fewer
 * than forty-eight left, and once the email digest is configured it is emailed
 * instead of pushed and then marked as sent — so it is never pushed at all.
 * That is the exact failure this whole application was built to prevent, so
 * this one kind ignores the silence.
 */
const URGENT: ReadonlySet<NoticeKind> = new Set<NoticeKind>(["closing_soon"]);

export function split(
  notices: Notice[],
  log: NoticeLogEntry[],
  now: Date,
  quiet: boolean,
): Split {
  /*
   * The two channels remember separately, because they are not the same
   * promise.
   *
   * One set of keys meant an email could retire a notice permanently. And email
   * is where the daily cap sends its overflow — so with more than six things
   * waiting, an opening would be summarised in a digest, marked delivered, and
   * never pushed at all. That is the wrong way round: the digest is a summary he
   * reads when he happens to open his mail; the push is the thing that reaches
   * him at a desk in a game or asleep with the phone beside him, which is what a
   * closing window needs.
   *
   * So an announcement stays a push candidate until it has actually been pushed,
   * however many digests have mentioned it. Housekeeping — a source that stopped
   * loading, the classifier being down — is genuinely finished once it has been
   * said anywhere, and is retired by either channel.
   */
  const pushedKeys = new Set(log.filter((e) => (e.via ?? "push") === "push").map((e) => e.key));
  const digestedKeys = new Set(log.filter((e) => e.via === "digest").map((e) => e.key));

  const stillNeedsPush = (n: Notice): boolean =>
    OPPORTUNITY_KINDS.has(n.kind) ? !pushedKeys.has(n.key) : !pushedKeys.has(n.key) && !digestedKeys.has(n.key);
  const stillNeedsDigest = (n: Notice): boolean =>
    !digestedKeys.has(n.key) && !pushedKeys.has(n.key);

  /*
   * A status about today, delivered today, or not at all.
   *
   * `classifier:2026-09-02` was pushed on the fourth: held two days by the old
   * daily cap, then released by the new budget carrying a count that was two
   * days stale. A state of the tool is only worth saying while it is the state
   * of the tool. An opening is the opposite - it keeps until it is delivered,
   * which is why this drops statuses and nothing else.
   */
  const todayKey = dayOf(now.toISOString());
  const notStale = (n: Notice): boolean => {
    if (!STATUS_KINDS.has(n.kind)) return true;
    const dated = /:(\d{4}-\d{2}-\d{2})$/.exec(n.key)?.[1];
    return dated === undefined || dated === todayKey;
  };

  const fresh = notices.filter(stillNeedsPush).filter(notStale);
  const pushedToday = log.filter(
    (e) => dayOf(e.sentISO) === dayOf(now.toISOString()) && (e.via ?? "push") === "push",
  );
  const sentToday = pushedToday.length;

  /*
   * Two budgets, because they answer to two different rules. See
   * DAILY_OPPORTUNITY_CAP: openings are the product and are bounded only against
   * a runaway; housekeeping is a state of the tool and keeps spec 5.4's six.
   *
   * The log does not record a kind, so an opening is identified by its key
   * prefix, which is how every opportunity key in this file is minted
   * ("new:", "opened:", "closing:", "seats:").
   */
  const OPPORTUNITY_KEY = /^(?:new|opened|closing|seats|fit):/;
  const opportunitiesSentToday = pushedToday.filter((e) => OPPORTUNITY_KEY.test(e.key)).length;
  const maintenanceSentToday = sentToday - opportunitiesSentToday;

  /**
   * Take from a ranked list until each budget is spent.
   *
   * `atNight` collapses both budgets back to spec 5.4's six. The larger
   * opportunity budget buys speed during the day; at three in the morning
   * speed is worth nothing and twenty buzzes is the fatigue the quiet window
   * exists to prevent. A closing window still gets through the silence — that
   * exemption is unchanged — it just cannot get through twenty times.
   */
  const withinBudgets = (
    ranked: Notice[],
    atNight: boolean,
  ): { push: Notice[]; overflow: Notice[] } => {
    const oppCap = atNight ? DAILY_PUSH_CAP : DAILY_OPPORTUNITY_CAP;
    const push: Notice[] = [];
    const overflow: Notice[] = [];
    let usedOpp = 0;
    let usedMaint = 0;
    for (const n of ranked) {
      const isOpportunity = OPPORTUNITY_KINDS.has(n.kind);
      const room = atNight
        ? sentToday + usedOpp + usedMaint < DAILY_PUSH_CAP
        : isOpportunity
          ? opportunitiesSentToday + usedOpp < oppCap
          : maintenanceSentToday + usedMaint < DAILY_PUSH_CAP;
      if (room) {
        push.push(n);
        if (isOpportunity) usedOpp++;
        else usedMaint++;
      } else {
        overflow.push(n);
      }
    }
    return { push, overflow };
  };

  if (quiet) {
    /*
     * The cap applies at night too, and did not.
     *
     * Quiet hours let a closing window through, which is right: a deadline that
     * passes at dawn cannot wait until seven. But the branch returned every
     * urgent notice with no ceiling at all, so a night on which twenty windows
     * entered their final forty-eight hours would have woken him twenty times
     * between eleven and seven. The exemption is from the silence, not from the
     * budget.
     *
     * Ordered by urgency so that if the budget does bite, what gets through is
     * the window closing soonest.
     */
    const urgent = fresh
      .filter((n) => URGENT.has(n.kind))
      .sort((a, b) => effectiveWeight(b, now) - effectiveWeight(a, now));
    const tonight = withinBudgets(urgent, true);
    return {
      push: tonight.push,
      digestOnly: [...fresh.filter((n) => !URGENT.has(n.kind)), ...tonight.overflow].filter(
        stillNeedsDigest,
      ),
    };
  }
  const ranked = [...fresh].sort((a, b) => effectiveWeight(b, now) - effectiveWeight(a, now));

  /*
   * The same sentence never goes out twice in one batch.
   *
   * Keys are per-record and per-day, so two notices can carry identical text and
   * still be two different keys: the classifier alarm is keyed by date, and a
   * queue held over two days holds it twice. A preview of what would arrive at
   * seven in the morning had six pushes of which two read "🟠 التصنيف متوقّف"
   * and two more named the same organisation — four of the six slots spent
   * saying two things.
   *
   * Deduplicating on what the reader actually sees, rather than on the key,
   * is the only test that matches what he experiences.
   */
  const seen = new Set<string>();
  const distinct = ranked.filter((n) => {
    /*
     * A status is deduplicated on its kind; an opening never is.
     *
     * "🟠 التصنيف متوقّف" is keyed by date and its body carries a count, so a
     * queue held over two days holds it twice with different text — the same
     * fact, twice, wearing different numbers. Two of six morning slots went to
     * it. It is a state of the tool, so only the newest is worth sending.
     *
     * Openings are matched on their exact text and nothing looser. Two records
     * at one organisation may be one programme or two, and collapsing them on
     * the organisation's name would hide the second. The asymmetry that governs
     * this whole project applies here too: one opening shown twice costs a
     * swipe, one hidden costs a semester.
     */
    const face = STATUS_KINDS.has(n.kind) ? n.kind : `${n.kind}|${n.title}|${n.body}`;
    if (seen.has(face)) return false;
    seen.add(face);
    return true;
  });

  const today = withinBudgets(distinct, false);
  return {
    push: today.push,
    // Everything past the cap is summarised, once. It stays in the push queue.
    digestOnly: today.overflow.filter(stillNeedsDigest),
  };
}

/**
 * The kinds that describe an opening rather than the tool's own health.
 *
 * Only these are held back from being retired by a digest, because only these
 * cost a semester when they arrive in the wrong place at the wrong time.
 */
export const OPPORTUNITY_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>([
  "new_relevant",
  "fit_unknown",
  "opened",
  "closing_soon",
  "few_seats",
]);

/**
 * Kinds that report a state of the tool rather than an event in the world.
 *
 * Only the newest of these is worth sending: the reader does not need to be
 * told twice that the classifier is behind, once with yesterday's count.
 */
const STATUS_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>(["classifier_down"]);

/**
 * Weight, plus what waiting has earned.
 *
 * Ranking on the stored weight alone let a real announcement starve. The daily
 * cap is six; the queue routinely holds more than six; so a notice that ranks
 * seventh today ranks seventh again tomorrow, and again the day after, until the
 * seven-day expiry throws it away unsent. It is not a hypothetical: four
 * announcements queued on 31 August were carrying weights of 65 and 70 while
 * everything queued since scored above 260, and they would have expired on the
 * 7th of September without one of them ever being sent.
 *
 * The stored weights are also not comparable across time. They were computed by
 * whatever version of `decide` was running that day, and this project has
 * changed those numbers more than once. Age is the correction that does not
 * depend on which version produced the figure.
 *
 * A day of waiting is worth 40, which is deliberately large enough to matter and
 * small enough that a genuinely urgent notice still goes first: a closing window
 * outranks a three-day-old "new announcement" on the day it starts closing, and
 * loses to it after four days of neither being sent. Nothing starves.
 */
const AGING_PER_DAY = 40;

export function effectiveWeight(n: Notice, now: Date): number {
  const queued = "queuedISO" in n && typeof n.queuedISO === "string" ? Date.parse(n.queuedISO) : NaN;
  if (Number.isNaN(queued)) return n.weight;
  const days = Math.max(0, (now.getTime() - queued) / 86_400_000);
  return n.weight + days * AGING_PER_DAY;
}
