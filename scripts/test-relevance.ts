/**
 * The score, which is now arithmetic and therefore testable.
 *
 * While a model produced this number it could only be spot-checked. It is a
 * pure function of the page's own words and the reader's profile, so every
 * band, every bonus and every refusal can be pinned down here - including the
 * one that matters most, which is that a zero is only ever produced on purpose.
 *
 *   npm run test:relevance
 */
import { CASES } from "./benchmark-cases";
import { fieldOf, readProfile, relevanceOf, type ReaderProfile } from "../src/pipeline/relevance";
import type { Classification } from "../src/pipeline/classify";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CYBER_READER: ReaderProfile = {
  field: "cyber",
  cities: ["الرياض"],
  graduated: false,
  fieldLabel: "الأمن السيبراني",
};

const facts = (over: Partial<Classification>): Pick<Classification, "product" | "majors" | "titleAr" | "cities"> => ({
  product: "coop",
  majors: [],
  titleAr: null,
  cities: [],
  ...over,
});

console.log("the profile is read, or the scoring is refused");
{
  check(
    "a cybersecurity student is recognised",
    readProfile("Final-year cybersecurity student, Taif University")?.field === "cyber",
  );
  check(
    "and so is the Arabic wording",
    readProfile("طالب سنة أخيرة في الأمن السيبراني بجامعة الطائف")?.field === "cyber",
  );
  /*
   * Deliberately free of anything that looks like a real profile line. The
   * first draft of this fixture carried an invented grade average, and the
   * privacy gate stopped the run over it - correctly, since it cannot tell an
   * invented one from a real one and must not learn to. It stopped the run a
   * second time over a comment that merely quoted the string, which is also
   * correct: a pattern in a public repository is a pattern.
   */
  check(
    "a profile naming no field at all is refused, not guessed",
    readProfile("- طالب سنة أخيرة\n- يحب المشي الطويل") === null,
  );
  check(
    'the template\'s "NOT yet graduated" is understood',
    readProfile("cybersecurity student\n- NOT yet graduated — he is INELIGIBLE")?.graduated === false,
  );
  check(
    "a profile that does not say is left unknown, not assumed",
    readProfile("cybersecurity student at Taif")?.graduated === null,
  );
  check("a city in the profile is picked up", readProfile("أمن سيبراني، الرياض")?.cities.includes("الرياض") === true);
}

console.log("\nthe bands are the specification's");
{
  const cyber = relevanceOf(facts({ titleAr: "محلل أمن سيبراني", majors: ["الأمن السيبراني"] }), CYBER_READER);
  check("cybersecurity scores 90 or more", cyber.score >= 90, String(cyber.score));

  const it = relevanceOf(facts({ titleAr: "متدرب شبكات", majors: ["نظم المعلومات"] }), CYBER_READER);
  check("networks and systems land in 60-85", it.score >= 60 && it.score <= 85, String(it.score));

  const general = relevanceOf(
    facts({ titleAr: "متدرب الدعم التقني", majors: ["تقنية المعلومات"] }),
    CYBER_READER,
  );
  check(
    "a help desk lands in 20-50 even though its poster invites IT students",
    general.score >= 20 && general.score <= 50,
    String(general.score),
  );

  const unrelated = relevanceOf(facts({ titleAr: "تدريب في الموارد البشرية", majors: ["إدارة أعمال"] }), CYBER_READER);
  check("an unrelated field lands in 0-15", unrelated.score <= 15, String(unrelated.score));

  const civil = relevanceOf(facts({ titleAr: "تدريب الهندسة المدنية", majors: ["الهندسة المدنية"] }), CYBER_READER);
  check("and so does civil engineering, which 'هندسة' alone used to promote", civil.score <= 15, String(civil.score));

  check("nothing ever exceeds 100", relevanceOf(facts({ titleAr: "أمن سيبراني", majors: ["الأمن السيبراني"], cities: ["الرياض"] }), CYBER_READER).score <= 100);
}

/*
 * The asymmetric checks. A score that is too high costs a glance at a card; a
 * score that is wrongly zero is an opportunity the reader never hears about,
 * and this project exists to prevent exactly that.
 */
console.log("\nzero is only ever said on purpose");
{
  const gd = relevanceOf(facts({ product: "graduate_dev", titleAr: "تطوير الخريجين" }), CYBER_READER);
  check("a graduate programme scores 0 for a reader who has not graduated", gd.score === 0);
  check("and says why, in Arabic", gd.reason.includes("تخرّج") && gd.reason.length > 10, gd.reason);

  const unknownGrad: ReaderProfile = { ...CYBER_READER, graduated: null };
  const gd2 = relevanceOf(
    facts({ product: "graduate_dev", titleAr: "برنامج تطوير الخريجين في الأمن السيبراني", majors: ["الأمن السيبراني"] }),
    unknownGrad,
  );
  check(
    "but NOT when the profile never said whether he graduated",
    gd2.score > 0,
    `${gd2.score} — ${gd2.reason}`,
  );

  const nothingKnown = relevanceOf(facts({}), CYBER_READER);
  check(
    "an announcement with no majors and no title is scored low, never zero",
    nothingKnown.score > 0 && nothingKnown.score <= 15,
    String(nothingKnown.score),
  );
}

console.log("\nevery score comes with a sentence that explains it");
{
  let empty = 0;
  let english = 0;
  for (const c of CASES) {
    const r = relevanceOf(facts({ titleAr: c.text, majors: [] }), CYBER_READER);
    if (r.reason.trim().length === 0) empty++;
    // The card is Arabic. A stray English clause on it is the bug that put a
    // BadRequestError on seventy-four cards.
    if (/[A-Za-z]{4,}/.test(r.reason)) english++;
  }
  check("no reason is ever empty, which is what broke 8 of 20 live judgements", empty === 0, `${empty} empty`);
  check("and none of them is in English", english === 0, `${english} with English`);
}

console.log("\nthe twenty benchmark announcements land in their documented bands");
{
  let wrong = 0;
  for (const c of CASES) {
    const r = relevanceOf(
      facts({ product: c.band === "graduate_dev" ? "graduate_dev" : "coop", titleAr: c.text }),
      CYBER_READER,
    );
    const ok =
      c.band === "cyber" ? r.score >= 90
      : c.band === "it" ? r.score >= 60 && r.score <= 85
      : c.band === "graduate_dev" ? r.score === 0
      : c.band === "general" ? r.score >= 20 && r.score <= 50
      : r.score <= 15;
    if (!ok) {
      wrong++;
      console.log(`    ${c.id.padEnd(14)} band=${c.band.padEnd(13)} score=${r.score}  ${r.reason}`);
    }
  }
  check("all twenty", wrong === 0, `${wrong} outside their band`);
}

console.log("\nthe field detector is not fooled by the neighbouring word");
{
  check('"تعاون" alone is not a technical field', fieldOf("تعزيز التعاون المشترك") === "none");
  check('"أمن المعلومات" is cyber', fieldOf("أمن المعلومات") === "cyber");
  check('"علوم الحاسب" is IT, not cyber', fieldOf("علوم الحاسب") === "it");
  check("English counts too", fieldOf("Cybersecurity Analyst") === "cyber");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
