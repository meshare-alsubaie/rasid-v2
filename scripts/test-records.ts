/**
 * Three ways the collector used to destroy its own data, and the guards on them.
 *
 * Each of these was found by audit, not by a test, because the paths only run
 * on a bad day: a mistyped flag, a classifier that has been down for two rounds,
 * an organisation whose pages all fail at once. A bad day is exactly when the
 * user is relying on the record that was already there.
 *
 * The pass criterion throughout is the audit's: **could this silently throw away
 * something the user cannot get back?**
 *
 *   npm run test:records
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { addressOf } from "../src/pipeline/address";
import {
  asManualReview,
  fromClassification,
  survivingRecord,
  UNJUDGED_TITLE,
} from "../src/pipeline/opportunity";
import type { Classification } from "../src/pipeline/classify";
import { announcementKey } from "../src/types";
import type { Opportunity } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

const NOW = "2026-09-02T10:00:00.000Z";
const common = (sourceUrl: string, prior?: Opportunity) => ({
  orgId: "acme",
  sourceUrl,
  text: "نص الصفحة",
  nowISO: NOW,
  prior,
  firstTime: true,
});

const classification = (titleAr: string): Classification => ({
  isTrainingAnnouncement: true,
  product: "coop",
  titleAr,
  opensISO: null,
  closesISO: null,
  opensRaw: null,
  closesRaw: null,
  moreOnPage: false,
  majors: ["الأمن السيبراني"],
  seats: null,
  stipendSAR: null,
  durationWeeks: null,
  cities: [],
  statesZeroCoursesRule: false,
  zeroCoursesQuote: null,
  applyUrl: null,
});

/* ---------- ق‑٤٣ · one id per page, and it does not move ---------- */

console.log("\nrecord identity");

const a = asManualReview({ ...common("https://acme.sa/coop/ar"), reason: "api — down" });
const b = asManualReview({ ...common("https://acme.sa/coop/en"), reason: "api — down" });
const c = asManualReview({ ...common("https://acme.sa/careers"), reason: "api — down" });

check(
  "three unjudged pages of one organisation get three ids",
  new Set([a.id, b.id, c.id]).size === 3,
  `${a.id} ${b.id} ${c.id}`,
);

/*
 * The collector stores records in a Map keyed by id, so a collision is not a
 * cosmetic clash: the later record overwrites the earlier one and the earlier
 * page is gone from the round entirely. This asserts the consequence, not just
 * the hash, because the consequence is what the user loses.
 */
const stored = new Map([a, b, c].map((o) => [o.id, o]));
check("all three survive a map keyed by id", stored.size === 3, `${stored.size} of 3`);

const titleShifted = [
  fromClassification({ ...common("https://acme.sa/coop/ar"), c: classification("برنامج التدريب التعاوني") }),
  fromClassification({ ...common("https://acme.sa/coop/ar"), c: classification("التدريب التعاوني ١٤٤٨") }),
];
check(
  "re-reading a page with different wording keeps the same id",
  titleShifted[0]!.id === titleShifted[1]!.id,
  `${titleShifted[0]!.id} vs ${titleShifted[1]!.id}`,
);

/*
 * The seeded fault. This is the old scheme, written out here so the gate fails
 * if anyone puts it back: it is stable against nothing and collides on the
 * constant placeholder title.
 */
const legacyId = (o: Opportunity): string =>
  createHash("sha256").update(`${o.orgId}|${o.titleAr}|${o.firstSeenISO}`).digest("hex").slice(0, 16);
check(
  "the old title-based scheme is genuinely broken (seeded fault)",
  legacyId(a) === legacyId(b) && legacyId(titleShifted[0]!) !== legacyId(titleShifted[1]!),
  "collides across pages and moves when the title moves",
);

/* ---------- ق‑٣٨ · one announcement is one card, on evidence ---------- */

console.log("\ntelling one announcement from two");
{
  const base = {
    orgId: "acme",
    titleAr: "برنامج التدريب التعاوني",
    closesISO: "2026-09-30",
    sourceUrl: "https://acme.sa/ar",
  };
  const sameProgrammeOtherPage = { ...base, sourceUrl: "https://acme.sa/en" };

  check(
    "the same title and the same closing date is one announcement",
    announcementKey(base) === announcementKey(sameProgrammeOtherPage),
  );
  check(
    "a different closing date is a different announcement",
    announcementKey(base) !== announcementKey({ ...sameProgrammeOtherPage, closesISO: "2026-11-30" }),
  );
  check(
    "and a different organisation always is",
    announcementKey(base) !== announcementKey({ ...base, orgId: "other" }),
  );
  check(
    "spelling differences in the title do not split it",
    announcementKey(base) ===
      announcementKey({ ...sameProgrammeOtherPage, titleAr: "برنامج التدريب التعاونى " }),
  );

  /*
   * The conservative half, and the one worth protecting. More than half the
   * records carry no closing date, and "برنامج التدريب التعاوني" is what most
   * of these pages call themselves — so grouping on the title alone would hide
   * a second genuine opening behind the first. Showing one opening twice costs
   * a swipe; hiding one costs a semester.
   */
  const noDate = { ...base, closesISO: null };
  const noDateOtherPage = { ...sameProgrammeOtherPage, closesISO: null };
  check(
    "without a published date, nothing is collapsed",
    announcementKey(noDate) !== announcementKey(noDateOtherPage),
    "there is no evidence they are the same programme, and guessing loses openings",
  );
  check(
    "and such a record is still stable across re-readings of its own page",
    announcementKey(noDate) === announcementKey({ ...noDate, titleAr: "عنوان مختلف تماماً" }),
  );
}

/* ---------- a window that closes before it opens is not stored ---------- */

console.log("\ndates that contradict each other");
{
  const withDates = (opensRaw: string | null, closesRaw: string | null): Opportunity =>
    fromClassification({
      ...common("https://acme.sa/window"),
      c: { ...classification("برنامج التدريب التعاوني"), opensRaw, closesRaw },
    });

  const backwards = withDates("31 أكتوبر 2025", "13 يوليو 2025");
  check(
    "neither date is kept when the deadline precedes the opening",
    backwards.opensISO === null && backwards.closesISO === null,
    `${String(backwards.opensISO)} → ${String(backwards.closesISO)}`,
  );
  check(
    "and the record goes to review rather than being scored on them",
    backwards.relevanceScore === null && backwards.flags.includes("needs_manual_review"),
    backwards.flags.join(","),
  );

  const ordered = withDates("13 يوليو 2025", "31 أكتوبر 2025");
  check(
    "an ordinary window is untouched",
    ordered.opensISO === "2025-07-13" && ordered.closesISO === "2025-10-31",
    `${String(ordered.opensISO)} → ${String(ordered.closesISO)}`,
  );

  const sameDay = withDates("31 أكتوبر 2025", "31 أكتوبر 2025");
  check(
    "a one-day window is a window",
    sameDay.opensISO === "2025-10-31" && sameDay.closesISO === "2025-10-31",
    `${String(sameDay.opensISO)} → ${String(sameDay.closesISO)}`,
  );

  const closesOnly = withDates(null, "31 أكتوبر 2025");
  check(
    "a deadline with no opening date is still a deadline",
    closesOnly.closesISO === "2025-10-31",
    String(closesOnly.closesISO),
  );
}

/* ---------- ق‑٣ · a failed re-read never deletes a real reading ---------- */

console.log("\nsurviving a classifier outage");

const judged: Opportunity = {
  ...fromClassification({
    ...common("https://acme.sa/coop/ar"),
    c: classification("برنامج التدريب التعاوني"),
  }),
};
const placeholder = asManualReview({ ...common("https://acme.sa/other"), reason: "api — down" });

check(
  "a real record is found before any failure",
  survivingRecord([judged, placeholder], "https://acme.sa/coop/ar")?.id === judged.id,
);

// Round one fails: the collector flags the good record and keeps it.
const flagged: Opportunity = { ...judged, flags: [...judged.flags, "needs_manual_review"] };

check(
  "round two still finds it, though round one flagged it",
  survivingRecord([flagged, placeholder], "https://acme.sa/coop/ar")?.id === judged.id,
);
check(
  "and it still carries the title the page gave",
  survivingRecord([flagged, placeholder], "https://acme.sa/coop/ar")?.titleAr === "برنامج التدريب التعاوني",
);
check(
  "a bare placeholder is not mistaken for a real reading",
  survivingRecord([placeholder], "https://acme.sa/other") === undefined,
);

/*
 * The seeded fault: the old predicate, which asked whether the record was
 * unflagged rather than whether it held a reading. On round two it finds
 * nothing, and the collector's `else` branch deletes every record for the page.
 */
const legacyFind = (rows: Opportunity[], url: string): Opportunity | undefined =>
  rows.find((o) => o.sourceUrl === url && !o.flags.includes("needs_manual_review"));
check(
  "the old flag-based predicate is genuinely broken (seeded fault)",
  legacyFind([flagged, placeholder], "https://acme.sa/coop/ar") === undefined,
  "round two would have deleted the judgement round one preserved",
);

check("the placeholder title constant is what asManualReview writes", placeholder.titleAr === UNJUDGED_TITLE);

/* ---------- ق‑٢ · a malformed --limit refuses instead of erasing ---------- */

console.log("\nthe flag that used to wipe the dataset");

/*
 * Counted, not compared byte for byte.
 *
 * The first version asserted the file was identical afterwards, which is true
 * of the defect but also true of nothing else on this machine: the resident
 * watcher writes this file every few minutes, so the check failed at random
 * whenever a round happened to land mid-test. A gate that fails for reasons
 * unrelated to what it guards teaches people to ignore it, which is worse than
 * not having it.
 *
 * What the defect actually did was empty the file. That is what is asserted.
 */
const rowsBefore = (JSON.parse(readFileSync("data/health.json", "utf8")) as unknown[]).length;
for (const arg of [[], ["abc"], ["0"], ["-3"], ["2.5"]]) {
  const shown = arg.length === 0 ? "(nothing)" : arg[0]!;
  const run = spawnSync("npx", ["tsx", "scripts/collect.ts", "--limit", ...arg], {
    encoding: "utf8",
    shell: true,
    timeout: 60_000,
  });
  check(`--limit ${shown} refuses with exit 2`, run.status === 2, `exit ${String(run.status)}`);
}
const rowsAfter = (JSON.parse(readFileSync("data/health.json", "utf8")) as unknown[]).length;
check(
  "and health.json still holds its records",
  rowsAfter >= rowsBefore,
  rowsBefore + " -> " + rowsAfter,
);

/* ---------- ق‑١ · a round always reaches its own write ---------- */

console.log("\nthe deadline that replaces being killed");

{
  /*
   * Behavioural. The collector is given a deadline it has already missed, and
   * has to stop, report, write, and exit cleanly — rather than run on until the
   * watcher kills it and the whole round's reading is discarded.
   */
  const urls = "data/.deadline-probe.txt";
  const orgs = JSON.parse(readFileSync("data/organisations.json", "utf8").replace(/^﻿/, "")) as {
    sources: { url: string; verifiedAtISO: string | null }[];
  }[];
  const sample = orgs
    .flatMap((o) => o.sources.filter((s) => s.verifiedAtISO !== null).map((s) => s.url))
    .slice(0, 3);
  writeFileSync(urls, sample.join("\n") + "\n", "utf8");

  // Row count, not bytes: the watcher writes this file while the suite runs.
  const probedUrls = new Set(sample);
  const healthBefore = (JSON.parse(readFileSync("data/health.json", "utf8")) as {sourceUrl: string; lastAttemptISO: string}[])
    .filter((h) => probedUrls.has(h.sourceUrl))
    .map((h) => h.sourceUrl + "|" + h.lastAttemptISO)
    .sort()
    .join();
  const run = spawnSync("npx", ["tsx", "scripts/collect.ts", "--urls", urls], {
    encoding: "utf8",
    shell: true,
    timeout: 120_000,
    env: { ...process.env, RASID_RUN_DEADLINE_MS: "1" },
  });
  rmSync(urls, { force: true });

  check("a round past its deadline still exits 0", run.status === 0, `exit ${String(run.status)}`);
  check(
    "and says how many sources it did not open",
    /deadline\s+reached after .*; 3 source\(s\) not opened and still due/.test(run.stdout ?? ""),
    (run.stdout ?? "").split("\n").filter((l) => l.includes("deadline")).join("") || "no deadline line",
  );
  const healthAfter = (JSON.parse(readFileSync("data/health.json", "utf8")) as {sourceUrl: string; lastAttemptISO: string}[])
    .filter((h) => probedUrls.has(h.sourceUrl))
    .map((h) => h.sourceUrl + "|" + h.lastAttemptISO)
    .sort()
    .join();
  check(
    "sources it did not open keep their health record, so they stay due",
    healthAfter === healthBefore,
  );
}

{
  /*
   * Structural, and named as such: these two live inside the watcher's own loop,
   * which cannot be imported without starting it. What they guard is the pair of
   * mistakes that made ق‑١ fatal — two ceilings set independently, and a kill
   * treated as though it were an ordinary failure.
   */
  const src = readFileSync("scripts/watch.ts", "utf8");
  check(
    "the collector's deadline is derived from the kill timer, not set beside it",
    /COLLECT_DEADLINE_MS\s*=\s*Math\.max\([^)]*CHILD_TIMEOUT_MS\s*-\s*WRITE_MARGIN_MS/.test(src),
  );
  check(
    "and it is handed to the child",
    /RASID_RUN_DEADLINE_MS:\s*String\(COLLECT_DEADLINE_MS\)/.test(src),
  );
  check(
    "a killed round does not advance the schedule",
    /collectExit === 124[\s\S]{0,200}stay due[\s\S]{0,120}else\s*\{[\s\S]{0,160}markChecked/.test(src),
    "a kill writes nothing at all, so marking the sources checked is a false green light",
  );
}

console.log("\nan anchor is the same page and a hash route is not");
{
  /*
   * Both dedupers threw the whole fragment away. On a hash-routed portal —
   * and Saudi sites run plenty of them — the entire path lives after the `#`,
   * so two different announcement pages collapsed into one url and one of them
   * was dropped as a duplicate. The page stays live, the organisation reads as
   * watched, and nothing ever connects the two. It is the quietest way this
   * project can fail, which is why it is here rather than in a comment.
   */
  const same = (a: string, b: string): boolean => addressOf(a) === addressOf(b);

  check("an anchor does not make a new page", same("https://x.gov.sa/c#apply", "https://x.gov.sa/c"));
  check("nor does an empty fragment", same("https://x.gov.sa/c#", "https://x.gov.sa/c"));
  check("nor does a trailing slash", same("https://x.gov.sa/c/", "https://x.gov.sa/c"));
  check(
    "two hash routes stay two pages",
    !same("https://x.gov.sa/#/careers/coop", "https://x.gov.sa/#/careers/graduate"),
    addressOf("https://x.gov.sa/#/careers/coop"),
  );
  check(
    "and the older #! convention too",
    !same("https://x.gov.sa/#!/coop", "https://x.gov.sa/#!/graduate"),
  );
  check(
    "a fragment we cannot classify is kept, because keeping one costs a fetch",
    !same("https://x.gov.sa/c#tab=coop&year=1448", "https://x.gov.sa/c"),
  );
}

console.log(`\n${failures === 0 ? "all record guards hold" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
