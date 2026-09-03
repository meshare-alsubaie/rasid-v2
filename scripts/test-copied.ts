/**
 * Nothing reaches a score on words the page never printed.
 *
 * The schema this classifier validates against is structurally strict and
 * semantically empty: it checks that a reply has the right shape, and cannot
 * tell an announcement from a fluent invention. Six records in the live data
 * proved it — a national cybersecurity body scored 90 on a title that is not
 * Arabic words, a bank scored 0 (the one number meaning "you cannot apply") on
 * another, cities that do not exist earned a proximity bonus, and a published
 * condition was quoted with two words the page never carried.
 *
 * The guard is possible only because the prompt orders these fields *copied*.
 * A copy that is not in the text the model was shown was not a copy.
 *
 * Both directions are measured here, and the first matters more than the
 * second: a guard that refuses real announcements would lose exactly what this
 * project exists to catch.
 *
 *   npm run test:copied
 */
import { readFileSync } from "node:fs";
import { CASES } from "./benchmark-cases";
import { MAX_EXCERPT_CHARS, normaliseArabic, notCopiedFrom } from "../src/pipeline/classify";
import type { Classification } from "../src/pipeline/classify";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

/* ---------- it must not refuse a real announcement ---------- */

console.log("\nevery stored benchmark answer is accepted");
{
  const answers = (
    JSON.parse(readFileSync("data/benchmark.json", "utf8")) as {
      answers: Record<string, Classification>;
    }
  ).answers;

  let checked = 0;
  const refused: string[] = [];
  for (const c of CASES) {
    const a = answers[c.id];
    if (a === undefined) continue;
    checked++;
    const invented = notCopiedFrom(c.text.slice(0, MAX_EXCERPT_CHARS), a);
    if (invented.length > 0) refused.push(`${c.id}: ${invented.join(" | ")}`);
  }

  check("the corpus is not empty", checked >= 20, `${checked} fixture(s)`);
  check(
    "none of them is refused",
    refused.length === 0,
    refused.slice(0, 3).join(" ;; ") || `${checked} accepted`,
  );
}

/* ---------- Arabic that differs only in spelling is the same Arabic ---------- */

console.log("\nspelling differences are not forgeries");
{
  const pairs: [string, string][] = [
    ["التدريب التعاونيّ", "التدريب التعاوني"],
    ["الأمن السيبراني", "الامن السيبراني"],
    ["مستوى", "مستوي"],
    ["جامعة الطائف", "جامعه الطائف"],
    ["ابـــن", "ابن"],
    ["الرياض‏", "الرياض"],
    ["سطر\n\n آخر", "سطر آخر"],
  ];
  for (const [page, reply] of pairs) {
    check(
      `${page} reads as ${reply}`,
      normaliseArabic(page) === normaliseArabic(reply),
    );
  }
}

/* ---------- it must refuse what the page does not say ---------- */

console.log("\nwording the page never printed is refused");
{
  const page = [
    "برنامج التدريب التعاوني لدى الهيئة الوطنية للأمن السيبراني.",
    "التخصصات المطلوبة: الأمن السيبراني، علوم الحاسب.",
    "المدينة: الرياض. عدد المقاعد: 4.",
    "يشترط اجتياز جميع المواد الدراسية قبل بدء التدريب.",
    "آخر موعد للتقديم: 12 ربيع الأول 1448.",
  ].join("\n");

  const base: Classification = {
    isTrainingAnnouncement: true,
    product: "coop",
    titleAr: "برنامج التدريب التعاوني",
    opensISO: null,
    closesISO: null,
    opensRaw: null,
    closesRaw: "12 ربيع الأول 1448",
    moreOnPage: false,
    majors: ["الأمن السيبراني"],
    seats: 4,
    stipendSAR: null,
    durationWeeks: null,
    cities: ["الرياض"],
    statesZeroCoursesRule: true,
    zeroCoursesQuote: "يشترط اجتياز جميع المواد الدراسية قبل بدء التدريب",
    applyUrl: null,
  };

  check("a faithful reply about this page is accepted", notCopiedFrom(page, base).length === 0);

  /*
   * Every one of these is a shape taken from the live data, not invented for
   * the test. They are what the app is currently showing.
   */
  const forgeries: [string, Classification][] = [
    ["a title that is not Arabic words", { ...base, titleAr: "البراغات الالميدية" }],
    ["a title translated to English", { ...base, titleAr: "Cooperative Training Program" }],
    ["the excerpt echoed back as JSON", { ...base, titleAr: '{"isTrainingAnnouncement": true}' }],
    ["majors the page never listed", { ...base, majors: ["Computer Science", "Cybersecurity"] }],
    ["a placeholder major", { ...base, majors: ["undefined"] }],
    ["a city that does not exist", { ...base, cities: ["الحيءة"] }],
    ["a city the page never named", { ...base, cities: ["أي مدينة"] }],
    ["a deadline the page never wrote", { ...base, closesRaw: "غداً" }],
    ["a condition quoted in words the page lacks", { ...base, zeroCoursesQuote: "انتظام كلي" }],
    [
      "a published condition with nothing quoted",
      { ...base, statesZeroCoursesRule: true, zeroCoursesQuote: null },
    ],
  ];

  for (const [label, reply] of forgeries) {
    const invented = notCopiedFrom(page, reply);
    check(label, invented.length > 0, invented.join(" | ").slice(0, 90) || "ACCEPTED, which is the bug");
  }

  /*
   * The seeded fault: what the schema alone concluded about the same replies.
   * If this ever passes, the guard has stopped being the thing doing the work.
   */
  const schemaAlone = (r: Classification): boolean =>
    r.isTrainingAnnouncement && typeof r.titleAr === "string" && r.titleAr.trim().length > 0;
  check(
    "the schema alone accepts all of them (seeded fault)",
    forgeries.every(([, r]) => schemaAlone(r)),
    "which is why six invented records are in the live data",
  );
}

/* ---------- absence is not a forgery ---------- */

console.log("\nnothing is required to be present");
{
  const page = "صفحة أخبار عادية بلا أي إعلان تدريب.";
  const empty: Classification = {
    isTrainingAnnouncement: false,
    product: "unknown",
    titleAr: null,
    opensISO: null,
    closesISO: null,
    opensRaw: null,
    closesRaw: null,
    moreOnPage: false,
    majors: [],
    seats: null,
    stipendSAR: null,
    durationWeeks: null,
    cities: [],
    statesZeroCoursesRule: false,
    zeroCoursesQuote: null,
    applyUrl: null,
  };
  check("a reply that claims nothing is accepted", notCopiedFrom(page, empty).length === 0);
}

console.log(`\n${failures === 0 ? "the guard holds in both directions" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
