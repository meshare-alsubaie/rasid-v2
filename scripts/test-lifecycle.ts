/**
 * The two failures an adversarial audit proved, held down by tests.
 *
 * Both were silent, both would have cost a real window, and both passed every
 * other check in this repository at the time they were found:
 *
 *   1. A status computed once and stored never moved again, so a window that
 *      opened after its page stopped changing stayed "announced but not open"
 *      for its whole life and never raised an alert.
 *   2. A page that stopped mentioning training deleted the opportunity outright,
 *      with no record and no notice — a redesign, a cookie wall or a soft 404
 *      was enough.
 *
 *   npm run test:lifecycle
 */
import { statusFor } from "../src/types";
import { decide } from "../src/pipeline/notify";
import type { Opportunity } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: "x1",
  orgId: "sdaia",
  titleAr: "برنامج التدريب التعاوني",
  detectedISO: "2026-08-01T00:00:00.000Z",
  firstSeenISO: "2026-08-01T00:00:00.000Z",
  lastConfirmedISO: "2026-08-01T00:00:00.000Z",
  status: "announced_not_open",
  opensISO: null,
  closesISO: null,
  closesHijri: null,
  product: "coop",
  majors: [],
  seats: null,
  stipendSAR: null,
  durationWeeks: null,
  cities: [],
  relevanceScore: 95,
  relevanceReason: "اختبار.",
  statesZeroCoursesRule: false,
  zeroCoursesQuote: null,
  flags: [],
  sourceUrl: "https://example.gov.sa/coop",
  applyUrl: null,
  rawExcerpt: "",
  ...over,
});

const at = (iso: string): number => Date.parse(iso);

console.log("a window opens on the calendar, not when the page changes");

/*
 * The exact case the audit built: classified in August as "announced but not
 * open", the page never touched again, and today is inside the window.
 */
const inWindow = opp({
  status: "announced_not_open",
  opensISO: "2026-08-20",
  closesISO: "2026-09-30",
});
check(
  "a window whose opening date has passed is open, whatever was stored",
  statusFor(inWindow, at("2026-08-30T06:00:00.000Z")) === "open",
  statusFor(inWindow, at("2026-08-30T06:00:00.000Z")),
);

const closingTomorrow = opp({
  status: "announced_not_open",
  opensISO: "2026-08-20",
  closesISO: "2026-08-31",
});
check(
  "and it becomes closing_soon inside the last 48 hours",
  statusFor(closingTomorrow, at("2026-08-30T06:00:00.000Z")) === "closing_soon",
  statusFor(closingTomorrow, at("2026-08-30T06:00:00.000Z")),
);
check(
  "on its final day it is still not closed, at nine in the morning Riyadh",
  statusFor(closingTomorrow, at("2026-08-31T06:00:00.000Z")) === "closing_soon",
  statusFor(closingTomorrow, at("2026-08-31T06:00:00.000Z")),
);
check(
  "and it closes once that day has ended in Riyadh",
  statusFor(closingTomorrow, at("2026-08-31T21:30:00.000Z")) === "closed",
  statusFor(closingTomorrow, at("2026-08-31T21:30:00.000Z")),
);
check(
  "a stored 'open' does not survive its own closing date",
  statusFor(opp({ status: "open", closesISO: "2026-08-01" }), at("2026-08-30T06:00:00.000Z")) ===
    "closed",
);
check(
  "no dates still means unknown, never open",
  statusFor(opp({ status: "open" }), at("2026-08-30T06:00:00.000Z")) === "unknown",
);
check(
  "a graduate-development programme is never open, whatever its dates",
  statusFor(
    opp({ product: "graduate_dev", opensISO: "2026-08-01", closesISO: "2026-12-31" }),
    at("2026-08-30T06:00:00.000Z"),
  ) === "unknown",
);
/*
 * "Not judged" and "no dates" are two different unknowns.
 *
 * This asserted that any `needs_manual_review` record is `unknown`, whatever
 * dates it holds — and that was the conflation, not the rule. The flag means
 * the *relevance* could not be worked out: the page named no field this reader
 * recognises. The dates are separate; they were read off the page and converted
 * by the Umm al-Qura table before anyone tried to score anything.
 *
 * Hiding a real open window because nobody could score it is the wrong
 * direction for this project. A deadline nobody scored is still a deadline, and
 * he can act on it himself — the card already shows it unscored and flagged for
 * review, so nothing is claiming more than it knows.
 */
check(
  "an unjudged record with a real window is still shown as open",
  statusFor(
    opp({ flags: ["needs_manual_review"], opensISO: "2026-08-01", closesISO: "2026-12-31" }),
    at("2026-08-30T06:00:00.000Z"),
  ) === "open",
);
check(
  "and an unjudged record with no dates is still unknown",
  statusFor(
    opp({ flags: ["needs_manual_review"], opensISO: null, closesISO: null }),
    at("2026-08-30T06:00:00.000Z"),
  ) === "unknown",
);
check(
  "and a closed window stays closed however it was flagged",
  statusFor(
    opp({ flags: ["needs_manual_review"], opensISO: "2026-01-01", closesISO: "2026-02-01" }),
    at("2026-08-30T06:00:00.000Z"),
  ) === "closed",
);

console.log("\nthe opening of a window is announced");

/*
 * The consequence of the fix above: because the status now moves on its own,
 * `decide` sees the transition and raises the alert that never used to fire.
 */
const before = [inWindow];
const after = [{ ...inWindow, status: statusFor(inWindow, at("2026-08-30T06:00:00.000Z")) }];
const notices = decide({
  before,
  after,
  healthBefore: [],
  healthAfter: [],
  nameOf: () => "سدايا",
  threshold: 60,
});
check(
  "a window that opens by the calendar raises an 'opened' notice",
  notices.some((n) => n.kind === "opened"),
  notices.map((n) => n.kind).join(",") || "none",
);

console.log("\na record is never deleted for going quiet");
const vanished = opp({ status: "open", opensISO: "2026-08-20", closesISO: "2026-09-30" });
vanished.flags = [...vanished.flags, "vanished_from_source"];
check(
  "a vanished record keeps its dates and its score",
  vanished.relevanceScore === 95 && vanished.closesISO === "2026-09-30",
);
check(
  "and it is still judged by the calendar rather than dropped",
  statusFor(vanished, at("2026-08-30T06:00:00.000Z")) === "open",
  statusFor(vanished, at("2026-08-30T06:00:00.000Z")),
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
