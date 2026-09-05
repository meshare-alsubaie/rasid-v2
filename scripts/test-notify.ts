/**
 * The notification rules, exercised against made-up runs.
 *
 * What is being defended here is the user's attention. A notifier that repeats
 * itself, or wakes someone for a programme he cannot apply to, gets muted, and
 * a muted app misses the seven-day window it exists to catch.
 *
 *   npm run test:notify
 */
import { VAPID_PUBLIC_KEY } from "../src/app/vapid";
import {
  decide,
  inQuietHours,
  split,
  ANNOUNCE_WINDOW_DAYS,
  BAND,
  DAILY_OPPORTUNITY_CAP,
  DAILY_PUSH_CAP,
  LOG_RETENTION_DAYS,
  type Notice,
} from "../src/pipeline/notify";
import { announcementKey } from "../src/types";
import { UNJUDGED_TITLE } from "../src/pipeline/opportunity";
import type { Opportunity, SourceHealth } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: "x",
  orgId: "sdaia",
  titleAr: "برنامج التدريب التعاوني",
  /*
   * Relative to now, not a date typed into the file. These were fixed at
   * 2026-08-01, and once announcing was bounded to a window measured from the
   * first sighting, every case built on this fixture began failing for a reason
   * that had nothing to do with what it was testing: the fixture had aged past
   * the window. A record in an ordinary run is days old, so the fixture is too.
   */
  detectedISO: new Date(Date.now() - 86_400_000).toISOString(),
  firstSeenISO: new Date(Date.now() - 86_400_000).toISOString(),
  lastConfirmedISO: new Date(Date.now() - 86_400_000).toISOString(),
  status: "unknown",
  opensISO: null,
  closesISO: null,
  closesHijri: null,
  product: "coop",
  majors: [],
  seats: null,
  stipendSAR: null,
  durationWeeks: null,
  cities: [],
  relevanceScore: 90,
  relevanceReason: "مطابق",
  statesZeroCoursesRule: false,
  zeroCoursesQuote: null,
  flags: [],
  sourceUrl: "https://example.gov.sa/a",
  applyUrl: null,
  rawExcerpt: "",
  ...over,
});

const health = (
  state: SourceHealth["state"],
  sourceUrl = "https://example.gov.sa/a",
  orgId = "sdaia",
): SourceHealth => ({
  sourceUrl,
  orgId,
  lastAttemptISO: new Date().toISOString(),
  lastSuccessISO: null,
  consecutiveFailures: state === "broken" ? 6 : 0,
  lastError: state === "broken" ? "gone" : null,
  state,
});

const run = (before: Opportunity[], after: Opportunity[], hb: SourceHealth[] = [], ha: SourceHealth[] = []): Notice[] =>
  decide({ before, after, healthBefore: hb, healthAfter: ha, nameOf: (id) => (id === "sdaia" ? "سدايا" : `جهة ${id}`), threshold: 60 });

console.log("what earns a notification");
check("a new relevant announcement does", run([], [opp({})]).some((n) => n.kind === "new_relevant"));
check(
  "a low-relevance one does not",
  run([], [opp({ relevanceScore: 20 })]).length === 0,
);

/*
 * A page is very often seen before it can be judged: the classifier fails, the
 * round runs out of budget, or the text is not readable on the first pass. That
 * sighting stores a record with a null score, which is rightly not announced.
 *
 * The rule used to be "announce a row that was not here last time", so once the
 * next round produced a verdict the row was no longer new and nothing was ever
 * sent. Two announcements scoring 95, both an exact match for his major, were
 * found sitting in the data in exactly that state: never queued, never sent.
 */
check(
  "a record judged only on a later round is still announced",
  run([opp({ relevanceScore: null })], [opp({ relevanceScore: 95 })]).some(
    (n) => n.kind === "new_relevant" && n.weight === BAND.newRelevant + 95,
  ),
  "seen first, judged second, is the normal path — not an edge case",
);
check(
  "and it is announced under the same key, so it can only go out once",
  run([opp({ relevanceScore: null })], [opp({ relevanceScore: 95 })]).find(
    (n) => n.kind === "new_relevant",
  )?.key === `new:${announcementKey(opp({}))}`,
);
check(
  "and one that becomes judgeable but scores low is still not announced",
  run([opp({ relevanceScore: null })], [opp({ relevanceScore: 20 })]).length === 0,
);
check(
  "a graduate-development one never does",
  run([], [opp({ product: "graduate_dev", flags: ["wrong_product"] })]).length === 0,
);
/*
 * This asserted that a null score is never news, and that was the hole.
 *
 * It is right about a page nothing could be read from. It is wrong about a page
 * that was read perfectly and simply did not list majors - which is how a great
 * many Saudi co-op pages are written. Measured on the live data: fourteen
 * confirmed co-op openings sat in that state and could never have notified him,
 * among them stc's own "Cooperative Training Program", Aramco, Al Rajhi, ZATCA,
 * Mobily and the Ministry of Justice. That is the failure criterion itself.
 */
check(
  "a co-op opening we could not score is announced, under a kind that says so",
  run([], [opp({ relevanceScore: null, flags: ["needs_manual_review"] })]).some(
    (n) => n.kind === "fit_unknown",
  ),
  "not scoring it is honest; not telling him is not",
);
check(
  "and it says the fit is unknown rather than giving a number nobody computed",
  run([], [opp({ relevanceScore: null, flags: ["needs_manual_review"] })])
    .find((n) => n.kind === "fit_unknown")
    ?.body.includes("لم تذكر الصفحة التخصّصات") === true,
);
check(
  "a real match still outranks it",
  BAND.newRelevant > BAND.fitUnknown,
  `${BAND.newRelevant} vs ${BAND.fitUnknown}`,
);
check(
  "a record with no usable title is still skipped",
  !run([], [opp({ relevanceScore: null, titleAr: UNJUDGED_TITLE, flags: ["needs_manual_review"] })]).some(
    (n) => n.kind === "fit_unknown",
  ),
  "a page nothing could be read from is still noise",
);
check(
  "and one whose page has gone quiet is skipped too",
  !run([], [opp({ relevanceScore: null, flags: ["needs_manual_review", "vanished_from_source"] })]).some(
    (n) => n.kind === "fit_unknown",
  ),
);
check(
  "it draws on the opportunity budget, not the housekeeping one",
  split(
    run([], [opp({ relevanceScore: null, flags: ["needs_manual_review"] })]),
    [],
    new Date("2026-09-01T09:00:00.000Z"),
    false,
  ).push.some((n) => n.kind === "fit_unknown"),
);
/*
 * Repetition is prevented by the sent log, not by `decide` guessing whether a
 * row looks new. `decide` proposes the same notice every round on purpose, so
 * that a record which arrives at a verdict late — the normal case, not an edge
 * case — is still announced. `split` is what refuses a key that has gone out.
 * That is the guarantee worth testing, so it is tested through both.
 */
check(
  "an unchanged announcement is proposed again",
  run([opp({})], [opp({})]).some((n) => n.key === `new:${announcementKey(opp({}))}`),
  "proposing is free; the sent log is what decides",
);
check(
  "but it is not delivered twice",
  split(
    run([opp({})], [opp({})]),
    [{ key: `new:${announcementKey(opp({}))}`, sentISO: "2026-08-31T06:00:00.000Z", via: "push" }],
    new Date("2026-09-01T09:00:00.000Z"),
    false,
  ).push.length === 0,
);
check(
  "and one that was never sent still goes out, however old the record is",
  split(
    run([opp({})], [opp({})]),
    [],
    new Date("2026-09-01T09:00:00.000Z"),
    false,
  ).push.some((n) => n.key === `new:${announcementKey(opp({}))}`),
  "this is what recovers a record the old newness rule silently skipped",
);
/*
 * The pair that keeps "propose every round" from turning into "announce again
 * next month". The sent log is pruned; a record that could still be proposed
 * after its log entry expired would come back as fresh news about an opening
 * that was announced weeks ago, with nothing anywhere to explain it.
 */
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
check(
  "the announcing window is strictly shorter than the log's memory",
  ANNOUNCE_WINDOW_DAYS < LOG_RETENTION_DAYS,
  `${ANNOUNCE_WINDOW_DAYS} < ${LOG_RETENTION_DAYS} days`,
);
check(
  "a record still waiting on a verdict a week later is announced",
  run(
    [opp({ firstSeenISO: daysAgo(7), relevanceScore: null })],
    [opp({ firstSeenISO: daysAgo(7), relevanceScore: 95 })],
  ).some((n) => n.kind === "new_relevant"),
);
check(
  "one first seen beyond the window is not announced again",
  !run([], [opp({ firstSeenISO: daysAgo(ANNOUNCE_WINDOW_DAYS + 1) })]).some(
    (n) => n.kind === "new_relevant",
  ),
  "by then the sent log still proves it went out, so silence is correct",
);
check(
  "a deadline on an old record is still announced, because that is not news about its arrival",
  run(
    [],
    [
      opp({
        firstSeenISO: daysAgo(60),
        closesISO: new Date(Date.now() + 30 * 3600_000).toISOString(),
      }),
    ],
  ).some((n) => n.kind === "closing_soon"),
);

check(
  "a status turning open does",
  run([opp({ status: "announced_not_open" })], [opp({ status: "open" })]).some((n) => n.kind === "opened"),
);
check(
  "a close within 48 hours does",
  run([], [opp({ closesISO: new Date(Date.now() + 30 * 3600_000).toISOString() })]).some(
    (n) => n.kind === "closing_soon",
  ),
);
check(
  "a close in two weeks does not",
  !run([], [opp({ closesISO: new Date(Date.now() + 14 * 86_400_000).toISOString() })]).some(
    (n) => n.kind === "closing_soon",
  ),
);
check(
  "a source going broken does",
  run([], [], [health("healthy")], [health("broken")]).some((n) => n.kind === "source_broken"),
);
check(
  "a source that was already broken does not",
  run([], [], [health("broken")], [health("broken")]).length === 0,
);

console.log("\nthe daily cap and quiet hours");
/*
 * Nine *different* announcements, not nine copies of one.
 *
 * These carried identical title and body, which is not a shape the pipeline
 * produces: two notices reading exactly the same thing are the same thing said
 * twice, and  now drops the repeat rather than spending a slot on it. A
 * fixture of clones was testing the cap against a case that cannot occur, and
 * would have passed just as happily if the cap were removed.
 */
const many: Notice[] = Array.from({ length: 9 }, (_, i) => ({
  key: `k${i}`,
  kind: "new_relevant",
  title: `إعلان جديد · جهة ${i}`,
  body: `برنامج التدريب التعاوني ${i}`,
  weight: i,
}));
const now = new Date("2026-09-01T12:00:00.000Z");

/*
 * Nine openings all go out, and this assertion is the opposite of what it used
 * to be.
 *
 * It read `capped.push.length === DAILY_PUSH_CAP` — six of nine pushed, three
 * to the digest — and that was a faithful test of spec 5.4 and a faithful test
 * of a product that misses windows. On 2026-09-03 thirteen notices were
 * generated, six went out, and seven real openings sat in the queue every one
 * already past the six-hour promise. The cap and the failure criterion cannot
 * both hold on a busy day, and the failure criterion is the one the owner calls
 * the single measure of failure.
 *
 * So openings answer to DAILY_OPPORTUNITY_CAP and housekeeping keeps the six.
 * This is a deliberate change of behaviour, not a threshold loosened to make a
 * red test green: the number that moved is the product decision, and the test
 * moved with it because the old expectation was the defect.
 */
const capped = split(many, [], now, false);
check(
  `all ${many.length} openings are pushed, because openings are the product`,
  capped.push.length === many.length,
  String(capped.push.length),
);
check("and nothing is left for the digest", capped.digestOnly.length === 0, String(capped.digestOnly.length));
check(
  `the opportunity budget still bounds a runaway at ${DAILY_OPPORTUNITY_CAP}`,
  split(
    Array.from({ length: 40 }, (_, i) => ({
      key: `runaway${i}`,
      kind: "new_relevant" as const,
      title: `إعلان ${i}`,
      body: `نص ${i}`,
      weight: i,
    })),
    [],
    now,
    false,
  ).push.length === DAILY_OPPORTUNITY_CAP,
);
check(
  `housekeeping is still held to ${DAILY_PUSH_CAP}`,
  split(
    Array.from({ length: 12 }, (_, i) => ({
      key: `broken${i}`,
      kind: "source_broken" as const,
      title: `مصدر ${i}`,
      body: `نص ${i}`,
      weight: BAND.sourceBroken,
    })),
    [],
    now,
    false,
  ).push.length === DAILY_PUSH_CAP,
);
check(
  "and a night still holds everything to the small cap, however many windows close",
  split(
    Array.from({ length: 20 }, (_, i) => ({
      key: `night${i}`,
      kind: "closing_soon" as const,
      title: `يغلق ${i}`,
      body: `نص ${i}`,
      weight: BAND.closingSoon,
    })),
    [],
    now,
    true,
  ).push.length === DAILY_PUSH_CAP,
);
check("the most urgent are the ones pushed", capped.push[0]!.weight === 8);

const quiet = split(many, [], now, true);
check("quiet hours push nothing", quiet.push.length === 0);
check("quiet hours still digest everything", quiet.digestOnly.length === 9);

/*
 * The night exemption is from the silence, not from the budget.
 *
 * A closing window is allowed through quiet hours because a deadline that
 * passes at dawn cannot wait until seven. But the branch returned every urgent
 * notice with no ceiling, so a night on which twenty windows entered their last
 * forty-eight hours would have woken him twenty times.
 */
{
  const closing: Notice[] = Array.from({ length: 20 }, (_, i) => ({
    key: `closing:${i}`,
    kind: "closing_soon",
    title: `⏳ يغلق قريباً · جهة ${i}`,
    body: `برنامج ${i}`,
    weight: BAND.closingSoon + i,
  }));
  const night = split(closing, [], now, true);
  check(
    "a night of twenty closing windows still respects the daily cap",
    night.push.length === DAILY_PUSH_CAP,
    `${night.push.length} pushed`,
  );
  check(
    "and the rest are held rather than dropped",
    night.push.length + night.digestOnly.length === closing.length,
    `${night.push.length} + ${night.digestOnly.length}`,
  );
  check(
    "the ones that go are the most urgent",
    night.push[0]!.weight === BAND.closingSoon + 19,
    String(night.push[0]!.weight),
  );
}

const repeat = split(many, many.map((n) => ({ key: n.key, sentISO: now.toISOString() })), now, false);
check("nothing already sent is sent twice", repeat.push.length === 0 && repeat.digestOnly.length === 0);

/*
 * The cap counts pushes, not deliveries.
 *
 * A quiet night routes everything to the email digest, and every digested item
 * was written to the same log the cap reads. Nine emailed items at three in the
 * morning therefore left no room to push anything at all the next day: the real
 * announcements were silently demoted to email, on the morning they mattered.
 */
const emailedLastNight = Array.from({ length: 9 }, (_, i) => ({
  key: `old${i}`,
  sentISO: now.toISOString(),
  via: "digest" as const,
}));
const morningAfter = split(many, emailedLastNight, now, false);
check(
  "a night of digests does not eat the next day's push budget",
  morningAfter.push.length === many.length,
  String(morningAfter.push.length),
);

/*
 * Keys matter now, not just the count. The two budgets are told apart by the
 * key prefix an opportunity notice is minted with, so a log of nine `old0..8`
 * entries counts as housekeeping and leaves the opening budget untouched. The
 * fixture uses real opportunity keys.
 */
const pushedAlready = Array.from({ length: DAILY_OPPORTUNITY_CAP }, (_, i) => ({
  key: `new:spent${i}`,
  sentISO: now.toISOString(),
  via: "push" as const,
}));
check(
  "pushes do still count against it",
  split(many, pushedAlready, now, false).push.length === 0,
  String(split(many, pushedAlready, now, false).push.length),
);
check(
  "and a spent housekeeping budget does not silence an opening",
  split(
    many,
    Array.from({ length: DAILY_PUSH_CAP }, (_, i) => ({
      key: `broken:spent${i}`,
      sentISO: now.toISOString(),
      via: "push" as const,
    })),
    now,
    false,
  ).push.length === many.length,
);

/* An entry written before the channel was recorded is counted as a push, which
   is the cautious reading: it can only ever hold notifications back, never let
   extra ones through. */
const legacy = pushedAlready.map(({ key, sentISO }) => ({ key, sentISO }));
check(
  "a log entry with no channel recorded is treated as a push",
  split(many, legacy, now, false).push.length === 0,
  String(split(many, legacy, now, false).push.length),
);

/*
 * A classifier that stops must be as loud as a crawler that stops. It was not:
 * `decide` skips a record it could not score, so an expired key meant no
 * notification would ever be sent again, from a system whose sources all looked
 * perfectly healthy.
 */
console.log("\nthe classifier going down is itself news");
const unjudged = (n: number): Opportunity[] =>
  Array.from({ length: n }, (_, i) =>
    opp({ id: `u${i}`, relevanceScore: null, flags: ["needs_manual_review"] }),
  );

const outage = run([], unjudged(5));
check(
  "five unjudged pages raise the alarm",
  outage.some((n) => n.kind === "classifier_down"),
  outage.map((n) => n.kind).join(",") || "none",
);
check(
  "one unjudged page does not",
  !run([], unjudged(1)).some((n) => n.kind === "classifier_down"),
);
check(
  "and it is said once a day, not once a round",
  new Set(run([], unjudged(5)).concat(run([], unjudged(9))).filter((n) => n.kind === "classifier_down").map((n) => n.key)).size === 1,
);
check(
  "an unjudged record still never becomes an opportunity notice",
  !outage.some((n) => n.kind === "new_relevant" || n.kind === "opened"),
);

console.log("\ntwo in one round, and neither is swallowed");
const pair: Notice[] = [
  { key: "new:nca", kind: "new_relevant", title: "أ", body: "b", weight: 95 },
  { key: "new:snb", kind: "new_relevant", title: "ب", body: "b", weight: 65 },
];
const both = split(pair, [], now, false);
check("both are pushed", both.push.length === 2, String(both.push.length));
check(
  "and they carry different keys, so the device cannot collapse them into one banner",
  new Set(both.push.map((n) => n.key)).size === 2,
);
check(
  "the more relevant one goes first",
  both.push[0]!.key === "new:nca",
  both.push.map((n) => n.key).join(","),
);

/*
 * A deadline is not allowed to wait for morning.
 *
 * Quiet hours exist so the app does not wake him for news that keeps. A window
 * closing inside forty-eight hours does not keep: held from 02:00 to 07:00 it
 * loses five of them, and if the digest is configured it is emailed instead and
 * never pushed at all. The whole product exists to prevent exactly this, so the
 * one notice kind that is about a deadline overrides the silence.
 */
console.log("\na deadline overrides quiet hours");
const atThree = new Date("2026-09-01T00:00:00.000Z"); // 03:00 in Riyadh
const deadline: Notice[] = [
  { key: "closing:x", kind: "closing_soon", title: "t", body: "b", weight: 300 },
  { key: "new:y", kind: "new_relevant", title: "t", body: "b", weight: 80 },
];
const night = split(deadline, [], atThree, true);
check(
  "a closing_soon notice is pushed at three in the morning",
  night.push.some((n) => n.kind === "closing_soon"),
  `push=[${night.push.map((n) => n.kind).join(",")}] digest=[${night.digestOnly.map((n) => n.kind).join(",")}]`,
);
check(
  "and everything that can wait still waits",
  !night.push.some((n) => n.kind === "new_relevant") &&
    night.digestOnly.some((n) => n.kind === "new_relevant"),
);
check(
  "a deadline already sent is still not sent twice, override or not",
  split(deadline, [{ key: "closing:x", sentISO: atThree.toISOString(), via: "push" }], atThree, true)
    .push.length === 0,
);

/*
 * Written as UTC instants, deliberately. Riyadh is UTC+3 and never moves, so
 * each of these is one unambiguous moment, and the test now says the same thing
 * on the owner's machine and on a runner in another timezone — which is the
 * whole point of the fix it guards.
 */
/*
 * The exact mix that exposed the inversion, replayed.
 *
 * Twelve sources had stopped loading and the classifier had failed on a batch,
 * which is an ordinary bad morning. Every one of those alarms outweighed an
 * opportunity, so the six push slots went to housekeeping and two co-op
 * announcements scoring 95 — both an exact match for his major — were ranked
 * into the digest. The digest is email, and email is not configured.
 *
 * An alarm about the tool is worth saying. It is never worth saying instead of
 * an opening.
 */
console.log("\na bad morning for the tool never buries an opening");
{
  /*
   * Twelve organisations, not twelve pages of one. Twelve identical pushes are
   * one message repeated, and  now spends one slot on them; what this
   * asserts is how the *remaining* slots are filled once the openings have
   * taken theirs, which needs twelve distinguishable alarms.
   */
  const broken = Array.from({ length: 12 }, (_, i) =>
    health("broken", `https://example.gov.sa/dead-${i}`, `org${i}`),
  );
  const wasBroken = broken.map((h) => ({ ...h, state: "degraded" as const }));
  /*
   * Two different openings, at two organisations. They used to be two records
   * of one organisation with identical title and body, which a reader receives
   * as the same push twice and cannot tell apart;  now spends one slot on
   * it rather than two. What this block is about is whether an opening outranks
   * a morning of tool alarms, and that needs two openings to be about.
   */
  const twoMatches = [
    opp({ id: "gold-a", orgId: "sdaia", titleAr: "برنامج التدريب التعاوني بسدايا", relevanceScore: 95, sourceUrl: "https://example.gov.sa/a" }),
    opp({ id: "gold-b", orgId: "nca", titleAr: "برنامج التدريب التعاوني بالهيئة", relevanceScore: 95, sourceUrl: "https://example.gov.sa/b" }),
  ];
  const unjudged = Array.from({ length: 9 }, (_, i) =>
    opp({ id: `u${i}`, relevanceScore: null, flags: ["needs_manual_review"] }),
  );

  const notices = run([], [...twoMatches, ...unjudged], wasBroken, broken);
  const { push } = split(notices, [], new Date("2026-09-01T09:00:00.000Z"), false);
  const pushed = new Set(push.map((n) => n.key));

  check(
    "both 95s are pushed, not digested",
    pushed.has(`new:${announcementKey(twoMatches[0]!)}`) && pushed.has(`new:${announcementKey(twoMatches[1]!)}`),
    `pushed: ${[...pushed].join(", ")}`,
  );
  check(
    "and they go first",
    push[0]!.key.startsWith("new:") && push[1]!.key.startsWith("new:"),
  );
  /*
   * This asserted the opposite, and the opposite is what reached his phone: a
   * "🟠 التصنيف متوقّف" alarm delivered in the same batch as three real
   * opportunity alerts. The round judged two records here, so the classifier is
   * demonstrably working and a backlog is only a backlog. An alarm that
   * contradicts the notification above it teaches him to disbelieve both.
   */
  check(
    "no stall alarm in a round that judged something, however long the queue",
    !push.some((n) => n.kind === "classifier_down"),
    push.filter((n) => n.kind === "classifier_down").map((n) => n.title).join(", "),
  );

  /* And it must still fire on a real stall: a queue, and nothing judged. */
  {
    const stalled = run([], unjudged, wasBroken, broken);
    check(
      "but it does fire when the queue is long and nothing was judged",
      stalled.some((n) => n.kind === "classifier_down"),
    );
  }

  /*
   * Twelve broken sources are one piece of news. Each used to be its own notice
   * titled "🔴 مصدر توقّف — <organisation>", and a phone truncates the title:
   * he woke to five notifications reading "مصدر توقّف..." over an identical
   * sentence, unable to tell which organisation any of them was about.
   */
  const brokenPushed = push.filter((n) => n.kind === "source_broken");
  check(
    "twelve broken sources become one notice",
    brokenPushed.length === 1,
    `${brokenPushed.length} notice(s)`,
  );
  check(
    "and the organisations are named in the body, which a phone shows in full",
    brokenPushed[0] !== undefined && brokenPushed[0].body.length > 40,
    brokenPushed[0]?.body.slice(0, 70) ?? "no notice",
  );
  check(
    "so housekeeping no longer fills the day's budget",
    brokenPushed.length < DAILY_PUSH_CAP,
  );
  check(
    "and every opening in the batch went out",
    push.filter((n) => n.key.startsWith("new:")).length === 2,
    String(push.filter((n) => n.key.startsWith("new:")).length),
  );

  /* Two or fewer stay as they are: one name in a title beats a list of one. */
  {
    const twoBroken = broken.slice(0, 2);
    const few = run([], twoMatches, twoBroken.map((h) => ({ ...h, state: "degraded" as const })), twoBroken);
    check(
      "two broken sources stay as two, each naming its organisation",
      few.filter((n) => n.kind === "source_broken").length === 2,
    );
  }
}

console.log("\na status about a past day is not delivered as though it were today's");
{
  /*
   * `classifier:2026-09-02` was pushed on the fourth - held two days by the old
   * daily cap, then released by the new budget carrying a count that was two
   * days stale. A state of the tool is only worth saying while it is the state
   * of the tool.
   */
  const stale: Notice = {
    key: "classifier:2026-09-02",
    kind: "classifier_down",
    title: "🟠 التصنيف لم يتقدّم",
    body: "قديم",
    weight: BAND.classifierDown,
  };
  const todays: Notice = { ...stale, key: "classifier:2026-09-04" };
  const at = new Date("2026-09-04T09:00:00.000Z");

  check(
    "a two-day-old status is dropped",
    split([stale], [], at, false).push.length === 0,
  );
  check(
    "today's is delivered",
    split([todays], [], at, false).push.length === 1,
  );
  check(
    "and an opening is never dropped for being old, because it keeps until sent",
    split(
      [{ key: "new:old", kind: "new_relevant", title: "إعلان", body: "نصّ", weight: 300 }],
      [],
      at,
      false,
    ).push.length === 1,
  );
}

console.log("\nthe order of the bands, stated once so it cannot drift");
{
  const at = (kind: string, list: Notice[]): number => list.find((n) => n.kind === kind)?.weight ?? -1;
  const deadline = run([opp({ closesISO: new Date(Date.now() + 36 * 3600_000).toISOString() })], [opp({ closesISO: new Date(Date.now() + 36 * 3600_000).toISOString() })]);
  const opened = run([opp({ status: "announced_not_open" })], [opp({ status: "open" })]);
  const fresh = run([], [opp({})]);
  const down = run([], Array.from({ length: 9 }, (_, i) => opp({ id: `d${i}`, relevanceScore: null, flags: ["needs_manual_review"] })));
  const dead = run([], [], [health("degraded")], [health("broken")]);
  check(
    "closing > opened > new > classifier_down > source_broken",
    at("closing_soon", deadline) > at("opened", opened) &&
      at("opened", opened) > at("new_relevant", fresh) &&
      at("new_relevant", fresh) > at("classifier_down", down) &&
      at("classifier_down", down) > at("source_broken", dead),
    `${at("closing_soon", deadline)} > ${at("opened", opened)} > ${at("new_relevant", fresh)} > ${at("classifier_down", down)} > ${at("source_broken", dead)}`,
  );
  check(
    "the lowest-scoring opening still outranks the tool complaining about itself",
    at("new_relevant", run([], [opp({ relevanceScore: 60 })])) > at("source_broken", dead),
  );
}

console.log("\nquiet-hour boundaries (Riyadh)");
const riyadh = (hhmmZ: string): Date => new Date(`2026-09-01T${hhmmZ}:00.000Z`);
check("23:00 Riyadh is quiet when quiet starts at 23", inQuietHours(riyadh("20:00"), 23, 7));
check("07:00 Riyadh is not quiet when quiet ends at 7", !inQuietHours(riyadh("04:00"), 23, 7));
check("03:00 Riyadh is quiet across midnight", inQuietHours(riyadh("00:00"), 23, 7));
check("12:00 Riyadh is never quiet", !inQuietHours(riyadh("09:00"), 23, 7));
check(
  "the runner's own timezone does not change the answer",
  inQuietHours(riyadh("20:00"), 23, 7) && !inQuietHours(riyadh("20:00"), 23, 7, "UTC"),
  "20:00Z is 23:00 in Riyadh but 20:00 in UTC",
);

/*
 * The key the phone needs, which was missing for a whole deployment.
 *
 * The site went live with VITE_VAPID_PUBLIC_KEY unset. The build succeeded,
 * the page rendered, and the only trace was one line inside a diagnostics
 * panel. Push notifications were off - the single thing this application
 * exists to deliver - and nothing would have said so until someone opened that
 * panel and read it.
 *
 * The key is now committed rather than kept in a secret, because it is public
 * by construction and a secret can be silently absent. This is the check that
 * a future refactor cannot quietly undo: no valid key, no green run.
 */
console.log("\nthe notification key the browser needs");
{
  const key = VAPID_PUBLIC_KEY;
  check("a public key is compiled into the app", Boolean(key), key ? "" : "empty");
  // A P-256 point, base64url-encoded: 65 bytes becomes 87 or 88 characters.
  check(
    "and it is the right shape for one",
    /^[A-Za-z0-9_-]{86,88}$/.test(key),
    `${key.length} chars`,
  );
  check(
    "it is the public half, not the private one",
    key.startsWith("B"),
    "an uncompressed P-256 public point begins with 0x04, which encodes as B",
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
