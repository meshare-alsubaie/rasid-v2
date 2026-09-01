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

const CYBER =
  /أمن\s*سيبراني|سيبراني|أمن\s*المعلومات|أمن\s*معلومات|عمليات\s*الأمن|cyber\s*security|cybersecurity|information\s*security|security\s*operations|\bSOC\b|penetration\s*test|اختبار\s*اختراق/i;

const IT =
  /شبكات|نظم\s*المعلومات|تقنية\s*المعلومات|علوم\s*الحاسب|هندسة\s*الحاسب|هندسة\s*البرمجيات|برمجة|برمجيات|علوم\s*البيانات|البيانات|ذكاء\s*اصطناعي|حوسبة\s*سحابية|networks?|information\s*technology|\bIT\b|computer\s*science|software|data\s*science|artificial\s*intelligence|cloud/i;

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

const GENERAL = /تقنية|تقني|رقمي|حاسب|technical|technolog|digital/i;

/**
 * Engineering that is not computing engineering.
 *
 * `GENERAL` used to match a bare "هندسة", which scored the benchmark's civil
 * engineering placement 35 - inside the general technical band - when the
 * specification puts it at 15 or less. It is a real announcement for a real
 * student and it is not this one: concrete testing in Yanbu has nothing to do
 * with a cybersecurity degree, and pretending otherwise fills the phone with
 * noise until the alerts stop being read.
 *
 * Listed by discipline rather than by excluding the word, so هندسة الحاسب and
 * هندسة البرمجيات are untouched.
 */
const NON_COMPUTING =
  /هندسة\s*مدنية|الهندسة\s*المدنية|معماري|عمارة|كيميائي|ميكانيكي|صناعية|بترول|نفط|تعدين|زراعي|مدني|civil\s*engineering|mechanical|chemical\s*engineering|architectur/i;

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
  if (NON_COMPUTING.test(text) && !IT.test(text)) return "none";
  if (SUPPORT.test(text)) return "general";
  if (IT.test(text)) return "it";
  if (GENERAL.test(text)) return "general";
  return "none";
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
  const graduated = /not\s+yet\s+graduated|لم\s*يتخرّ?ج|لم\s*يتخرج/i.test(profileText)
    ? false
    : /\bgraduated\b|تخرّ?ج\s*فعلي|حاصل\s*على\s*وثيقة\s*التخرج/i.test(profileText)
      ? true
      : null;

  const label = field === "cyber" ? "الأمن السيبراني" : field === "it" ? "التقنية" : "المجال التقني";
  return { field, cities, graduated, fieldLabel: label };
}

export interface Relevance {
  /** 0-100. Never null: a score this function returns is always a judgement. */
  score: number;
  /** One Arabic sentence naming the evidence. Never empty. */
  reason: string;
}

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
): Relevance {
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
  const score = announced === "none" ? UNRELATED : BASE[announced];

  if (announced === "none") {
    clauses.push("لا يذكر الإعلان تخصّصاً قريباً من تخصّصك");
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
