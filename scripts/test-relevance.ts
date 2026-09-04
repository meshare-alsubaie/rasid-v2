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
import {
  fieldOf,
  namesAField,
  readProfile,
  relevanceOf,
  type ReaderProfile,
  type Relevance,
} from "../src/pipeline/relevance";
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

/**
 * `relevanceOf` where a score is the only acceptable answer.
 *
 * The function may now refuse to judge, and refusing is right when the page
 * named no field at all. Every input below this line names one, so a refusal
 * here is itself the defect. NaN is returned rather than a number so that every
 * comparison against it is false and the check fails loudly, instead of a
 * sentinel that happens to satisfy a "less than" assertion.
 */
const scored = (
  c: Parameters<typeof relevanceOf>[0],
  reader: ReaderProfile,
): Relevance => {
  const r = relevanceOf(c, reader);
  if (r !== null) return r;
  check("refused to judge an input that names a field", false, JSON.stringify(c).slice(0, 90));
  return { score: NaN, reason: "" };
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
  const cyber = scored(facts({ titleAr: "محلل أمن سيبراني", majors: ["الأمن السيبراني"] }), CYBER_READER);
  check("cybersecurity scores 90 or more", cyber.score >= 90, String(cyber.score));

  const it = scored(facts({ titleAr: "متدرب شبكات", majors: ["نظم المعلومات"] }), CYBER_READER);
  check("networks and systems land in 60-85", it.score >= 60 && it.score <= 85, String(it.score));

  const general = scored(
    facts({ titleAr: "متدرب الدعم التقني", majors: ["تقنية المعلومات"] }),
    CYBER_READER,
  );
  check(
    "a help desk lands in 20-50 even though its poster invites IT students",
    general.score >= 20 && general.score <= 50,
    String(general.score),
  );

  const unrelated = scored(facts({ titleAr: "تدريب في الموارد البشرية", majors: ["إدارة أعمال"] }), CYBER_READER);
  check("an unrelated field lands in 0-15", unrelated.score <= 15, String(unrelated.score));

  const civil = scored(facts({ titleAr: "تدريب الهندسة المدنية", majors: ["الهندسة المدنية"] }), CYBER_READER);
  check("and so does civil engineering, which 'هندسة' alone used to promote", civil.score <= 15, String(civil.score));

  check("nothing ever exceeds 100", scored(facts({ titleAr: "أمن سيبراني", majors: ["الأمن السيبراني"], cities: ["الرياض"] }), CYBER_READER).score <= 100);
}

/*
 * The asymmetric checks. A score that is too high costs a glance at a card; a
 * score that is wrongly zero is an opportunity the reader never hears about,
 * and this project exists to prevent exactly that.
 */
console.log("\nzero is only ever said on purpose");
{
  const gd = scored(facts({ product: "graduate_dev", titleAr: "تطوير الخريجين" }), CYBER_READER);
  check("a graduate programme scores 0 for a reader who has not graduated", gd.score === 0);
  check("and says why, in Arabic", gd.reason.includes("تخرّج") && gd.reason.length > 10, gd.reason);

  const unknownGrad: ReaderProfile = { ...CYBER_READER, graduated: null };
  const gd2 = scored(
    facts({ product: "graduate_dev", titleAr: "برنامج تطوير الخريجين في الأمن السيبراني", majors: ["الأمن السيبراني"] }),
    unknownGrad,
  );
  check(
    "but NOT when the profile never said whether he graduated",
    gd2.score > 0,
    `${gd2.score} — ${gd2.reason}`,
  );

  /*
   * This assertion used to read "no majors and no title is scored low, never
   * zero", and it was wrong in the same way the code was: a page nothing could
   * be read from is not a page that is a poor fit. A low score is a verdict, and
   * there was no verdict. Thirty live records lifted from the gov.sa
   * registration banner have exactly this shape and were all reported at 10
   * under the sentence "the announcement names no field close to yours".
   */
  check(
    "an announcement with nothing readable in it is refused, not scored low",
    relevanceOf(facts({}), CYBER_READER) === null,
  );
  const otherField = scored(facts({ titleAr: "التدريب التعاوني — كلية الصيدلة" }), CYBER_READER);
  check(
    "but a page that names another field is judged, and judged low",
    otherField.score > 0 && otherField.score <= 15,
    String(otherField.score),
  );
}

/*
 * The wordings a real Saudi security placement uses. Every one of these scored
 * 10 before, which is the band for "not your field": the list recognised the
 * phrase الأمن السيبراني and almost nothing else.
 */
console.log("\nsecurity is recognised in the words employers actually use");
{
  const wordings = [
    "التدريب التعاوني — أمن الأنظمة الصناعية",
    "أمن التحكم الصناعي وأنظمة سكادا",
    "التدريب التعاوني — فريق الاستجابة للحوادث",
    "التدريب التعاوني في حوكمة المخاطر والامتثال",
    "التدريب التعاوني في أمن الشبكات",
    "التدريب التعاوني — حماية البيانات والخصوصية",
    "التدريب التعاوني في الأدلة الرقمية الجنائية",
    "التدريب التعاوني — الأمن الرقمي",
  ];
  const missed = wordings.filter((w) => fieldOf(w) !== "cyber");
  check("all eight read as security", missed.length === 0, missed.join(" | "));
}

console.log("\nand it is not fooled by a word inside another word");
{
  check(
    "data entry is not a computing placement",
    scored(facts({ titleAr: "متدرب إدخال البيانات" }), CYBER_READER).score <= 15,
  );
  check("accounting is not the general technical band", fieldOf("التدريب التعاوني — المحاسبة") === "none");
  check("the English pronoun is not the IT department", fieldOf("apply for it now") === "none");
  check("but the department still is", fieldOf("IT department internship") === "it");
  check("civil defence is not civil engineering", namesAField("المديرية العامة للدفاع المدني") === false);
  check(
    "and a petroleum university is not a petroleum placement",
    namesAField("جامعة الملك فهد للبترول والمعادن") === false,
  );
}

console.log("\nevery score comes with a sentence that explains it");
{
  let empty = 0;
  let english = 0;
  let refused = 0;
  for (const c of CASES) {
    const r = relevanceOf(
      facts({
        product: c.band === "graduate_dev" ? "graduate_dev" : "coop",
        titleAr: c.text,
        majors: [],
      }),
      CYBER_READER,
    );
    /*
     * A refusal carries no score, so it owes no sentence: the caller stores it
     * as a null score with `needs_manual_review`, and the card says that in
     * words of its own. What must never happen is a score with nothing to
     * explain it, which is the pairing checked below.
     */
    if (r === null) {
      refused++;
      continue;
    }
    if (r.reason.trim().length === 0) empty++;
    // The card is Arabic. A stray English clause on it is the bug that put a
    // BadRequestError on seventy-four cards.
    if (/[A-Za-z]{4,}/.test(r.reason)) english++;
  }
  check("no reason is ever empty, which is what broke 8 of 20 live judgements", empty === 0, `${empty} empty`);
  check("and none of them is in English", english === 0, `${english} with English`);
  check(
    "most of the corpus is still judged, so the refusal is not swallowing everything",
    refused <= CASES.length / 4,
    `${refused} of ${CASES.length} refused on the title alone`,
  );
}

console.log("\nthe twenty benchmark announcements land in their documented bands");
{
  let wrong = 0;
  for (const c of CASES) {
    const r = scored(
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

console.log("\na programme open to every major is open to his");
{
  /*
   * The worst defect this project has had, and the quietest.
   *
   * `fieldOf` looks for a named discipline. A page that opens its programme to
   * *all* disciplines names none, so it scored 10 — below the notification
   * floor of 60 — and the card printed "the announcement named specialisms,
   * none of which is close to yours" about a page that had named every one of
   * them. The whole category was permanently silent, and `sidf` sat in the live
   * dataset as `["All majors"]` scoring 10.
   *
   * Both halves are asserted: the number, and the sentence. A right score under
   * a wrong reason is how this went unnoticed for so long.
   */
  const NOTIFY_FLOOR = 60;
  const score = (majors: string[]): number | null =>
    relevanceOf({ product: "coop", majors, titleAr: "برنامج التدريب التعاوني", cities: [] }, CYBER_READER)
      ?.score ?? null;

  const phrasings = [
    "All majors",
    "جميع التخصصات",
    "كافّة التخصّصات",
    "كل التخصصات الجامعية",
    "لجميع التخصصات",
    "Any major",
    "All disciplines",
  ];
  for (const p of phrasings) {
    const s = score([p]);
    check(
      `"${p}" clears the notification floor`,
      s !== null && s >= NOTIFY_FLOOR,
      s === null ? "unscored" : `scored ${s}, floor is ${NOTIFY_FLOOR}`,
    );
  }

  const r = relevanceOf(
    { product: "coop", majors: ["All majors"], titleAr: "برنامج التدريب التعاوني", cities: [] },
    CYBER_READER,
  );
  check(
    "and the reason says why, rather than denying his field was named",
    r !== null && r.reason.includes("جميع التخصّصات") && !r.reason.includes("ليس فيها"),
    r?.reason ?? "no reason",
  );

  /*
   * The other half of the guard. A phrase about universities, or a genuinely
   * unrelated discipline, must not be swept in by a loose pattern - that would
   * trade a silent miss for a false alarm on every announcement in the country.
   */
  check("«الجامعات في المملكة» is not a majors phrase", score(["الجامعات في المملكة"]) === 10);
  check("a named unrelated discipline still scores low", score(["إدارة الأعمال"]) === 10);
  check("an exact field match is untouched", score(["الأمن السيبراني"]) === 90);
  check("an adjacent field is untouched", score(["Computer Science"]) === 65);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
