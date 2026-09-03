/**
 * How well an announcement fits the reader, worked out in code.
 *
 * This used to be two fields the model was asked for, and it was the wrong
 * question to ask a model twice over.
 *
 * It is not a judgement. "Does this programme's field match mine, is it in my
 * city, and am I even eligible to apply" is a comparison between two lists and
 * a date, and a comparison has one right answer that a table decides. The
 * project already learned this about Hijri dates: the model was good at
 * converting them and it still had to stop, because a field where one wrong
 * answer costs a semester may not depend on whether the model was careful this
 * time.
 *
 * And it was measurably breaking. On the first full run with a local model,
 * eight of twenty judgements failed the schema because `relevanceReason` came
 * back empty - a page fetched, read and understood, thrown away over a
 * sentence. Generated here, that sentence cannot be empty and cannot be wrong
 * about its own arithmetic.
 *
 * Three things follow from moving it, and all three were the point:
 *   - every displayed number is explicable from data on the page, which is the
 *     standing rule about numbers in this project
 *   - the model's reply gets shorter, and output was most of the work
 *   - the same pure function can run in a classmate's browser against their own
 *     profile, so the collection is shared and the judgement is not
 */
import type { Classification } from "./classify.js";

export type Field = "cyber" | "it" | "general" | "none";

export interface ReaderProfile {
  /** The strongest field the reader is qualified in. */
  field: Field;
  /** Lower-cased city names the reader can train in. Empty means anywhere. */
  cities: string[];
  /**
   * Whether the reader holds the degree document. `null` means the profile did
   * not say, and null is never treated as "no": see `relevanceOf`.
   */
  graduated: boolean | null;
  /** The exact wording the profile used for the field, for the reason line. */
  fieldLabel: string;
}

/**
 * Security, in the words Saudi employers actually use.
 *
 * The first version of this list recognised the phrase "الأمن السيبراني" and
 * little else, and an audit ran real announcement wordings through it: incident
 * response, GRC, industrial control security, network security and digital
 * forensics all came out as *unrelated*, scored 10, and would never have
 * reached the phone. Those are not edge cases; they are how the largest
 * employers in the country word a security placement. The benchmark could not
 * catch it because its one security case contains the word سيبراني.
 */
const CYBER =
  /أمن\s*سيبراني|سيبراني|أمن\s*المعلومات|أمن\s*معلومات|أمن\s*الشبكات|أمن\s*شبكات|أمن\s*الأنظمة|أمن\s*أنظمة|أمن\s*التطبيقات|الأمن\s*الرقمي|حماية\s*البيانات|حماية\s*المعلومات|الاستجابة\s*للحوادث|استجابة\s*الحوادث|الأدلة\s*الرقمية|التحليل\s*الجنائي\s*الرقمي|عمليات\s*الأمن|مركز\s*العمليات\s*الأمنية|حوكمة\s*المخاطر|المخاطر\s*والامتثال|أمن\s*التحكم\s*الصناعي|سكادا|cyber\s*security|cybersecurity|information\s*security|network\s*security|application\s*security|security\s*operations|incident\s*response|digital\s*forensics|threat\s*intelligence|\bSOC\b|\bGRC\b|\bSCADA\b|penetration\s*test|اختبار\s*اختراق/i;

/**
 * Computing, minus the two alternatives that were catching everything.
 *
 * A bare "البيانات" matched any clerical data-entry post, which is how
 * "متدرب إدخال البيانات" came to score 70. The English acronym is handled
 * separately below, because with a case-insensitive flag `\bIT\b` matches the
 * ordinary English pronoun "it" — enough on its own to score an English page 65.
 */
const IT =
  /شبكات|نظم\s*المعلومات|تقنية\s*المعلومات|علوم\s*الحاسب|هندسة\s*الحاسب|هندسة\s*البرمجيات|برمجة|برمجيات|علوم\s*البيانات|قواعد\s*البيانات|هندسة\s*البيانات|تحليل\s*البيانات|ذكاء\s*اصطناعي|حوسبة\s*سحابية|networks?|information\s*technology|computer\s*science|software|data\s*science|artificial\s*intelligence|cloud/i;

/** Case-sensitive on purpose: `IT` is a department, `it` is a pronoun. */
const IT_ACRONYM = /\bIT\b/;

/**
 * Computing-adjacent, but not a specialist computing role.
 *
 * The specification puts a help desk at 20-50 even when it invites computer
 * science students, and it is right to: the majors on the poster describe who
 * may apply, and the role describes what the semester is actually spent doing.
 * This is checked before the majors for exactly that reason - the benchmark's
 * `general_1` lists تقنية المعلومات وعلوم الحاسب and is a ticket queue.
 */
const SUPPORT =
  /دعم\s*تقني|الدعم\s*التقني|دعم\s*فني|مساندة\s*فنية|صيانة\s*الأجهزة|صيانة\s*أجهزة|التذاكر|help\s*desk|helpdesk|technical\s*support|it\s*support/i;

/*
 * `حاسب` is written with a guard because it is a substring of `المحاسبة`.
 * Every accounting placement in the country was landing in the general
 * technical band on the strength of four letters inside the word for
 * "accounting", which is also why accounting never appeared to be a miss.
 */
const GENERAL = /تقنية|تقني|رقمي|(?<!م)حاسب|technical|technolog|digital/i;

/**
 * A field that is named, and is not computing.
 *
 * This carries more weight than its name suggests, and it grew for two reasons.
 *
 * The first is the original one: `GENERAL` used to match a bare "هندسة", which
 * scored the benchmark's civil engineering placement 35 when the specification
 * puts it at 15 or less. Concrete testing in Yanbu is a real announcement for a
 * real student, and pretending it is nearly this one's field fills the phone
 * with noise until the alerts stop being read.
 *
 * The second is newer and matters more: `relevanceOf` has to distinguish "this
 * page named a field, and it is not yours" from "this page named nothing I can
 * read". The first is a judgement worth a low score. The second is not a
 * judgement at all, and scoring it low is how a page nobody could read came to
 * be reported as unsuitable. Only a list that recognises the *other* fields can
 * tell them apart, so the ordinary Saudi co-op disciplines are all named here.
 *
 * Written as whole disciplines rather than as bare words, because the bare
 * words were matching organisations rather than fields: `مدني` matched
 * الدفاع المدني and الأحوال المدنية, `صناعية` matched الثورة الصناعية الرابعة,
 * and `بترول` matched جامعة الملك فهد للبترول والمعادن. All three are bodies
 * whose computing placements were being thrown away as civil engineering.
 */
const NON_COMPUTING =
  new RegExp(
    [
      // engineering that is not computing engineering
      "هندسة\\s*مدنية", "الهندسة\\s*المدنية", "هندسة\\s*معمارية", "العمارة",
      "هندسة\\s*ميكانيكية", "هندسة\\s*كهربائية", "هندسة\\s*كيميائية",
      "هندسة\\s*صناعية", "الهندسة\\s*الصناعية", "هندسة\\s*البترول", "هندسة\\s*التعدين",
      "civil\\s*engineering", "mechanical\\s*engineering", "chemical\\s*engineering",
      "industrial\\s*engineering", "architectur",
      // health
      "الصيدلة", "صيدلة", "التمريض", "تمريض", "التغذية", "تغذية",
      "المختبرات\\s*الطبية", "الأشعة", "العلاج\\s*الطبيعي", "طب\\s*الأسنان",
      "الصحة\\s*العامة", "pharmac", "nursing", "nutrition", "radiolog",
      // business and administration
      "المحاسبة", "محاسبة", "المالية\\s*والمحاسبة", "التسويق", "تسويق",
      "الموارد\\s*البشرية", "موارد\\s*بشرية", "إدارة\\s*الأعمال",
      "سلاسل\\s*الإمداد", "الخدمات\\s*اللوجستية", "accounting", "marketing",
      "human\\s*resources", "supply\\s*chain",
      // clerical work that mentions data without being about data
      "إدخال\\s*البيانات", "إدخال\\s*بيانات", "أرشفة", "السكرتارية",
      "خدمة\\s*العملاء", "data\\s*entry", "customer\\s*service", "clerical",
      // law, media, teaching
      "القانون", "الأنظمة\\s*والقانون", "الحقوق", "الإعلام", "العلاقات\\s*العامة",
      "اللغات", "الترجمة", "التربية", "الشريعة",
      "\\blaw\\b", "journalism", "public\\s*relations",
    ].join("|"),
    "i",
  );

/** Saudi cities that appear in these announcements. Lower-cased on both sides. */
const CITIES = [
  "الرياض", "جدة", "مكة", "المدينة", "الدمام", "الخبر", "الظهران", "الطائف",
  "تبوك", "بريدة", "القصيم", "حائل", "أبها", "خميس مشيط", "جازان", "نجران",
  "الباحة", "عرعر", "سكاكا", "ينبع", "الجبيل", "الأحساء", "الهفوف", "نيوم",
];

/**
 * The order is the rule, and each step is there because a real case needed it.
 *
 * Security first, because a security role inside any department is still the
 * reader's field. Then non-computing engineering, which is excluded outright
 * rather than allowed to fall through to the generous general band. Then
 * support, which caps a help desk below the specialist bands however its
 * poster words the entry requirements. Only then the majors.
 */
export function fieldOf(text: string): Field {
  if (CYBER.test(text)) return "cyber";
  if (NON_COMPUTING.test(text) && !IT.test(text) && !IT_ACRONYM.test(text)) return "none";
  if (SUPPORT.test(text)) return "general";
  if (IT.test(text) || IT_ACRONYM.test(text)) return "it";
  if (GENERAL.test(text)) return "general";
  return "none";
}

/**
 * Did this text name any field at all, of any kind?
 *
 * `fieldOf` collapses two different answers into "none": a page about pharmacy,
 * and a page whose text could not be read. The score they deserve is not the
 * same — the first is a judgement, the second is the absence of one — so
 * `relevanceOf` asks this before it decides which it is looking at.
 */
export function namesAField(text: string): boolean {
  return (
    CYBER.test(text) ||
    NON_COMPUTING.test(text) ||
    SUPPORT.test(text) ||
    IT.test(text) ||
    IT_ACRONYM.test(text) ||
    GENERAL.test(text)
  );
}

/**
 * Read the reader out of the free-text profile.
 *
 * Returns null when the text names no field this can recognise. That is a
 * refusal, not a default: scoring against a reader we could not identify would
 * produce a number that looks like a judgement and is not one, and the number
 * that matters most here is the one that says "not for you".
 */
export function readProfile(profileText: string): ReaderProfile | null {
  const field = fieldOf(profileText);
  if (field === "none") return null;

  const cities = CITIES.filter((c) => profileText.includes(c)).map((c) => c.toLowerCase());

  /*
   * "NOT yet graduated" is stated by the profile template and is the fact that
   * makes the reader ineligible for تطوير الخريجين. Anything else is unknown,
   * and unknown is not "no": scoring a graduate programme zero for someone who
   * has in fact graduated would hide exactly the opportunity they can take.
   */
  /*
   * The first person, because that is how somebody writes about himself.
   *
   * This matched only "لم يتخرّج", the third person, and a profile reading
   * "لم أتخرج بعد" therefore left `graduated` unknown. The consequence is not
   * cosmetic: with it unknown, the branch that scores a graduate-development
   * programme zero is skipped, and a programme he cannot apply to scores 90.
   * The benchmark's own fixture uses the English phrasing, so no gate would
   * ever have surfaced it.
   */
  const graduated = /not\s+yet\s+graduated|لم\s*(?:يتخرّ?ج|أتخرّ?ج|اتخرّ?ج|تتخرّ?ج)/i.test(profileText)
    ? false
    : /\bgraduated\b|تخرّ?ج\s*فعلي|حاصل\s*على\s*وثيقة\s*التخرج/i.test(profileText)
      ? true
      : null;

  const label = field === "cyber" ? "الأمن السيبراني" : field === "it" ? "التقنية" : "المجال التقني";
  return { field, cities, graduated, fieldLabel: label };
}

export interface Relevance {
  /** 0-100. A score, when there is one, is always a judgement about the page. */
  score: number;
  /** One Arabic sentence naming the evidence. Never empty. */
  reason: string;
}

/*
 * `relevanceOf` returns null when it cannot judge, and the caller must store
 * that as a null score with `needs_manual_review` rather than as a low one.
 * There are two ways to be unable to judge: the reader's profile could not be
 * read, and the page named no field at all. Both are absences of evidence, and
 * neither is evidence of unsuitability.
 */

/** The bands are the specification's, and they are not moved to pass anything. */
const BASE: Record<Exclude<Field, "none">, number> = { cyber: 90, it: 65, general: 35 };
const UNRELATED = 10;

/**
 * The score, and the sentence that explains it.
 *
 * Facts in, number out, no model and no randomness. Every branch adds its own
 * clause to the reason, so the sentence and the number can never disagree: they
 * are produced by the same pass.
 */
export function relevanceOf(
  c: Pick<Classification, "product" | "majors" | "titleAr" | "cities">,
  reader: ReaderProfile,
): Relevance | null {
  const clauses: string[] = [];

  /*
   * Graduate development, for a reader who has not graduated, is zero.
   *
   * Zero here means "he cannot apply", which is a real judgement about a real
   * eligibility rule, not an inability to judge. When the profile did not say
   * whether he has graduated, this branch is skipped entirely and the
   * programme is scored on its field like any other - because a wrong zero is
   * an opportunity that never reaches him.
   */
  if (c.product === "graduate_dev" && reader.graduated === false) {
    return {
      score: 0,
      reason: "برنامج تطوير خريجين، ويشترط وثيقة التخرّج، فلا ينطبق عليك بعد.",
    };
  }
  if (c.product === "graduate_dev" && reader.graduated === null) {
    clauses.push("برنامج تطوير خريجين، وملفّك لا يذكر هل تخرّجت، فلم يُستبعد");
  }

  const haystack = [c.titleAr ?? "", ...c.majors].join(" ");
  const announced = fieldOf(haystack);

  /*
   * A page that named no field at all is not a page that named the wrong one.
   *
   * This function had no way to say "I could not tell". Every path returned a
   * number, and the only null in the judging half came from *his* profile being
   * unreadable — never from the page being unreadable. So a record with no
   * majors and an unusable title, which is the exact shape of the thirty
   * records lifted from the gov.sa registration banner, came out as a score of
   * 10 under the sentence "the announcement names no field close to yours".
   *
   * That sentence is a verdict on the announcement, and nothing was read. It is
   * the "could not judge" being written down as "not for you", which is the one
   * conversion this project exists to refuse. Null instead: the record is stored
   * unscored and flagged for review, a path `fromClassification` already has.
   */
  if (announced === "none" && c.majors.length === 0 && !namesAField(haystack)) {
    return null;
  }

  const score = announced === "none" ? UNRELATED : BASE[announced];

  if (announced === "none") {
    clauses.push("ذكر الإعلان تخصّصات ليس فيها ما يقارب تخصّصك");
  } else if (announced === reader.field) {
    clauses.push(`يذكر ${reader.fieldLabel}، وهو تخصّصك`);
  } else if (announced === "it" && reader.field === "cyber") {
    clauses.push("تخصّص تقني قريب من تخصّصك لا مطابق له");
  } else if (announced === "cyber" && reader.field !== "cyber") {
    clauses.push("إعلان أمن سيبراني، وتخصّصك أوسع منه");
  } else {
    clauses.push("مجال تقني عام");
  }

  let total = score;

  const cityMatch = reader.cities.length
    ? c.cities.find((city) => reader.cities.some((mine) => city.toLowerCase().includes(mine)))
    : undefined;
  if (cityMatch) {
    total += 5;
    clauses.push(`وفي ${cityMatch}`);
  } else if (reader.cities.length && c.cities.length) {
    clauses.push(`وفي ${c.cities.join("، ")}، خارج مدينتك`);
  }

  total = Math.max(0, Math.min(100, total));
  return { score: total, reason: clauses.join("، ") + "." };
}
