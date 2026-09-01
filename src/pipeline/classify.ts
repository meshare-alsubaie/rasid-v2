/**
 * Phase 3: ask Claude whether a changed page is an announcement this student
 * can actually apply to.
 *
 * The whole module is built around one rule: a classifier that could not judge
 * must never look like a classifier that judged "no". Spec section 5.3 sets the
 * failure path, and the three ways to get it quietly wrong are all closed here:
 *
 *   - a response that will not parse is NOT scored 0, it is a failure
 *   - an API call that never returned is NOT "no announcement", it is a failure
 *   - a missing field is NOT filled with a plausible default, it is a failure
 *
 * Zero means "not relevant to him". It never means "we could not tell".
 * Every failure comes back as `ok: false` and the caller is expected to store
 * the record with `relevanceScore: null` and a `needs_manual_review` flag.
 */
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { LOCAL_MODEL, askLocal, localModelReady, localTriage } from "./model.js";

/**
 * The model moved onto the owner's own machine, and the bill went to zero.
 *
 * The spec named claude-sonnet-4-6, then claude-sonnet-5. Both were good and
 * both cost about twelve dollars a month, which is money a final-year student
 * does not have for six months. Everything below this line - the schema, the
 * cross-field checks, the retry, the refusal to invent a verdict - is unchanged
 * and was worth keeping. Only the thing that answers is different, and it now
 * runs on a CPU in Riyadh for nothing.
 *
 * The name is still reported in the run log, because a reader must be able to
 * tell which model produced a verdict.
 */
export const CLASSIFIER_MODEL = LOCAL_MODEL;

/** Spec section 5.3: send only the changed text block, at most 6000 chars. */
export const MAX_EXCERPT_CHARS = 6000;

export interface Classification {
  isTrainingAnnouncement: boolean;
  product: "coop" | "graduate_dev" | "professional_experience" | "unknown";
  /**
   * DEVIATION FROM SPEC section 5.3, which types this as `string`.
   * A page that carries no announcement has no title, and the model correctly
   * returned null for one. Rejecting that put a page reading "لا توجد نتائج"
   * in the manual-review queue on every run, forever, at two API calls a time.
   * Null is accepted, and the cross-field check below still refuses a titleless
   * announcement - so the strictness stays exactly where it earns its keep.
   */
  titleAr: string | null;
  opensISO: string | null;
  closesISO: string | null;
  /**
   * The dates exactly as the page wrote them, before anyone interpreted them.
   *
   * The model used to be asked to convert Hijri to Gregorian itself. It is
   * good at it and that is not the point: the conversion has one right answer,
   * a table defines it, and a field where being a day out costs a semester
   * should not depend on a model being careful this time. So the model copies
   * the characters and `parseArabicDate` decides what they mean — and because
   * the raw string is kept, a reader can check the reading.
   */
  opensRaw: string | null;
  closesRaw: string | null;
  /**
   * Whether the page carries other distinct announcements besides this one.
   *
   * The pipeline keeps exactly one record per source — the delete-then-insert
   * in `collect.ts` guarantees it — so a careers page listing four open
   * programmes yields one, and the other three are invisible. That is a real
   * limit and it is common: portals list a co-op programme, a summer
   * programme, and a graduate scheme on the same page.
   *
   * Capturing all of them would mean an array in this schema and a different
   * identity scheme for records. Short of that, the honest thing is to know
   * that more exists and say so, so the user opens the page himself instead of
   * trusting a list that is quietly partial.
   */
  moreOnPage: boolean;
  majors: string[];
  seats: number | null;
  stipendSAR: number | null;
  durationWeeks: number | null;
  cities: string[];
  statesZeroCoursesRule: boolean;
  zeroCoursesQuote: string | null;
  relevanceScore: number;
  relevanceReason: string;
  applyUrl: string | null;
}

/**
 * Zero, because the model runs on the owner's own processor.
 *
 * This was $2/$10 per million tokens against Sonnet 5, verified on 2026-08-29.
 * It is now nothing, and the honest thing is to say so rather than delete the
 * cost line: a number that improves because we stopped measuring it is the
 * worst kind of failure, and this project has already been bitten by one.
 *
 * So money stays measured, at its true value of zero, and the run report gains
 * a metric that can still get worse - seconds of local inference. That is what
 * a runaway round now spends, and it is what the budget guard now bounds.
 */
export const PRICE_PER_MTOK = { input: 0, output: 0 } as const;

/**
 * What caching costs, as multiples of the ordinary input price.
 *
 * Storing the instructions costs a quarter more than sending them; reading them
 * back costs a tenth. Both are counted, because a saving that is only visible
 * by not being measured is not a saving — it is a number that stopped being
 * true. The API reports cached tokens in their own fields and leaves them out
 * of `input_tokens`, so a reader that ignored them would show the round getting
 * dramatically cheaper while the bill did not move.
 */
export const CACHE_MULTIPLIER = { write: 1.25, read: 0.1 } as const;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Instructions stored for the rest of the round. Charged at 1.25x input. */
  cacheWriteTokens?: number;
  /** Instructions read back instead of resent. Charged at 0.1x input. */
  cacheReadTokens?: number;
}

export const costOf = (u: Usage): number =>
  (u.inputTokens * PRICE_PER_MTOK.input +
    (u.cacheWriteTokens ?? 0) * PRICE_PER_MTOK.input * CACHE_MULTIPLIER.write +
    (u.cacheReadTokens ?? 0) * PRICE_PER_MTOK.input * CACHE_MULTIPLIER.read +
    u.outputTokens * PRICE_PER_MTOK.output) /
  1_000_000;

/**
 * Add one call's usage into a running total.
 *
 * Every place that summed tokens did it with two `+=` lines, and adding the two
 * cache fields meant finding all six of them and remembering all four fields at
 * each. Missing one would not break anything visibly — it would just make the
 * round look cheaper than it was, which is the kind of wrong number this
 * project exists to refuse. One function, so there is one place to be right.
 */
export function addUsage(total: Usage, one: Usage): void {
  total.inputTokens += one.inputTokens;
  total.outputTokens += one.outputTokens;
  total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (one.cacheWriteTokens ?? 0);
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (one.cacheReadTokens ?? 0);
}

/** What the same tokens would have cost with no cache, for reporting the saving. */
export const uncachedCostOf = (u: Usage): number =>
  ((u.inputTokens + (u.cacheWriteTokens ?? 0) + (u.cacheReadTokens ?? 0)) * PRICE_PER_MTOK.input +
    u.outputTokens * PRICE_PER_MTOK.output) /
  1_000_000;

export type ClassifyResult =
  | { ok: true; value: Classification; attempts: number; usage: Usage }
  | {
      ok: false;
      /** Where it broke, so health reporting can tell a bad key from a bad reply. */
      stage: "no_credentials" | "no_profile" | "api" | "parse" | "schema";
      reason: string;
      attempts: number;
      /** Tokens are still billed for a reply that failed to parse. */
      usage: Usage;
    };

/**
 * The one call to the model, isolated so tests can drive every failure branch
 * without a network or a bill. Production passes `liveAsk`.
 */
export type Asker = (excerpt: string, insist: boolean) => Promise<{ text: string; usage: Usage }>;

/**
 * The student profile is the one piece of this repository that describes a
 * person: university, GPA, certification, and the hours he is in class. The
 * repository is public, so it does not live here.
 *
 * It is read at runtime from `RASID_STUDENT_PROFILE`, or from a gitignored
 * `.profile.local` for convenience on a development machine. The prompt is
 * still assembled verbatim per spec section 5.3; only the storage moved.
 *
 * If neither exists, classification fails with `no_profile` rather than
 * running against a blank or invented profile. Judging a student's chances
 * against the wrong student is worse than not judging at all.
 */
export function studentProfile(): string | null {
  const fromEnv = process.env.RASID_STUDENT_PROFILE?.trim();
  if (fromEnv) return fromEnv;
  try {
    const local = readFileSync(".profile.local", "utf8").trim();
    return local || null;
  } catch {
    return null;
  }
}

/** Spec section 5.3, used verbatim. Do not paraphrase: it is the contract. */
export const buildSystemPrompt = (profile: string): string =>
  `You classify Saudi training announcements for one specific student.

STUDENT PROFILE
${profile}

Return ONLY valid JSON, no markdown fences, matching this schema:

{
  "isTrainingAnnouncement": boolean,
  "product": "coop" | "graduate_dev" | "professional_experience" | "unknown",
  "titleAr": string,
  "opensISO": string | null,
  "closesISO": string | null,
  "opensRaw": string | null,
  "closesRaw": string | null,
  "moreOnPage": boolean,
  "majors": string[],
  "seats": number | null,
  "stipendSAR": number | null,
  "durationWeeks": number | null,
  "cities": string[],
  "statesZeroCoursesRule": boolean,
  "zeroCoursesQuote": string | null,
  "relevanceScore": number,
  "relevanceReason": string,
  "applyUrl": string | null
}

RULES
- Extract only what the text actually states. Never infer a date or amount.
  If it is not written, return null.
- statesZeroCoursesRule is true ONLY if the text explicitly forbids registered
  courses or demands full-time availability as a condition. Copy the exact
  wording into zeroCoursesQuote. Absence of such a rule is NOT evidence of
  flexibility — it is simply absence.
- relevanceScore: 0 if product is "graduate_dev" (he cannot apply).
  90–100 if the role names cybersecurity, SOC, information security, or
  security analysis. 60–85 for networks, systems, IT, software, data.
  20–50 for general technical. 0–15 for unrelated fields.
- relevanceReason: one short Arabic sentence explaining the score.
- opensISO / closesISO: a Gregorian ISO date (YYYY-MM-DD) ONLY if the page
  itself gives one. Otherwise null. Do not convert a Hijri date yourself.
- opensRaw / closesRaw: the date exactly as the page writes it, copied
  verbatim — "12 ربيع الأول 1448", "١٤٤٨/٣/١٢", "15 سبتمبر 2026". Null if the
  page states no such date. Copy the characters; do not interpret them.

- moreOnPage: true when the page carries other distinct training announcements
  besides the one you described — a second programme, a different season, a
  separate track. Only one is recorded per page, so this is how the reader
  learns to open the page and look for the rest.

Dates are converted afterwards, in code, against the Umm al-Qura calendar. Your
job with a date is to find it and repeat it, not to work out what it means: a
deadline read a day wrong costs the reader a semester, and this is the one field
where a careful guess is worse than none.`;

/** Kept for tests and for anyone reading the contract without a profile set. */
export const SYSTEM_PROMPT_SHAPE = buildSystemPrompt("<RASID_STUDENT_PROFILE>");

/**
 * additionalProperties is false and every field is required on purpose. A
 * reply missing `closesISO` is a reply we cannot trust, not a reply with no
 * closing date: null has to be stated, never assumed.
 */
const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "isTrainingAnnouncement",
    "product",
    "titleAr",
    "opensISO",
    "closesISO",
    "opensRaw",
    "closesRaw",
    "moreOnPage",
    "majors",
    "seats",
    "stipendSAR",
    "durationWeeks",
    "cities",
    "statesZeroCoursesRule",
    "zeroCoursesQuote",
    "relevanceScore",
    "relevanceReason",
    "applyUrl",
  ],
  properties: {
    isTrainingAnnouncement: { type: "boolean" },
    product: {
      type: "string",
      enum: ["coop", "graduate_dev", "professional_experience", "unknown"],
    },
    titleAr: { type: ["string", "null"] },
    opensISO: { type: ["string", "null"] },
    closesISO: { type: ["string", "null"] },
    opensRaw: { type: ["string", "null"] },
    closesRaw: { type: ["string", "null"] },
    moreOnPage: { type: "boolean" },
    majors: { type: "array", items: { type: "string" } },
    seats: { type: ["integer", "null"], minimum: 0 },
    stipendSAR: { type: ["number", "null"], minimum: 0 },
    durationWeeks: { type: ["number", "null"], minimum: 0 },
    cities: { type: "array", items: { type: "string" } },
    statesZeroCoursesRule: { type: "boolean" },
    zeroCoursesQuote: { type: ["string", "null"] },
    relevanceScore: { type: "number", minimum: 0, maximum: 100 },
    relevanceReason: { type: "string", minLength: 1 },
    applyUrl: { type: ["string", "null"] },
  },
} as const;

const validate = new Ajv({ allErrors: true }).compile(schema);

/** Models are told not to fence. Stripping one is formatting, not invention. */
function unfence(raw: string): string {
  const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? raw).trim();
}

export const liveAsk: Asker = async (excerpt, insist) => {
  const profile = studentProfile();
  if (profile === null) throw new Error("RASID_STUDENT_PROFILE is not set");

  /*
   * The profile goes into the prompt, and the prompt does not leave the house.
   *
   * When this called a remote API, the student's university, GPA and class
   * hours travelled to a third party on every classification. Running the model
   * locally removes that entirely: the request goes to 127.0.0.1 and nothing
   * about him crosses the network. It is the same prompt, verbatim per spec
   * 5.3, read by a model on his own CPU.
   *
   * Prompt caching is gone with the bill it existed to reduce. Ollama keeps the
   * model resident between calls, which is the local equivalent and costs
   * nothing to arrange.
   */
  const call = await askLocal({
    system: buildSystemPrompt(profile),
    prompt: insist ? `${excerpt}\n\nReturn valid JSON only.` : excerpt,
    json: true,
    maxTokens: 900,
  });

  /*
   * Unreachable is reported as an answer that will not parse, never thrown.
   *
   * `classify` turns an unparseable reply into a `parse` failure, and a parse
   * failure is exactly the right outcome here: the page keeps
   * `pendingClassification`, it is retried next round, and a
   * needs_manual_review record says on screen that it was not judged. Throwing
   * would take the whole round down instead, and a round that dies is a day of
   * blindness.
   */
  if (call.error !== null) {
    return { text: `local model unavailable: ${call.error}`, usage: call.usage };
  }
  return { text: call.text, usage: call.usage };
};

/**
 * One word, before the seventeen fields.
 *
 * Measured: a full classification returns about seven hundred output tokens,
 * and output is seven-tenths of the bill. Nineteen pages in twenty are not
 * announcements, and paying seven hundred tokens to be told so — four times a
 * day, on a hundred and forty news pages — is where the money went.
 *
 * This asks the same model the same question in a form that can be answered in
 * one word, at roughly a thirtieth of the cost, and only the pages that say yes
 * are asked the expensive question.
 *
 * The instruction is deliberately biased. "If in doubt, say yes" is not
 * hedging: a false yes costs one cent, and a false no is an announcement nobody
 * ever looks at, which is the failure this whole application exists to prevent.
 * Pages already known to be about training skip this stage entirely.
 */
export const TRIAGE_PROMPT = `أنت تفحص نصّ صفحة من موقع جهة سعودية.

السؤال الوحيد: هل تحتوي هذه الصفحة على إعلان عن فرصة تدريب أو تدريب تعاوني أو
برنامج للطلاب أو الخريجين؟

أجب بكلمة واحدة فقط: نعم أو لا.

إن ترددت، أو كان النصّ ناقصاً، أو احتمل الأمرين — قل نعم. كلفة "نعم" الخاطئة
لا شيء، وكلفة "لا" الخاطئة أن يفوت الطالب فرصته.`;

export interface TriageResult {
  looksLikeAnnouncement: boolean;
  usage: Usage;
}

/**
 * The cheap first pass. Any answer that is not a clear "no" counts as yes,
 * including an error: this stage may only ever save money, never lose a page.
 */
/**
 * Enough of a page to answer one word, and no more.
 *
 * The first version sent the whole six-thousand-character excerpt to a question
 * whose answer is "yes" or "no", and input then accounted for three-quarters of
 * what the cheap stage cost. A yes/no does not need the whole page: it needs
 * the top, where announcements announce themselves, and the neighbourhood of
 * whatever training word got the page this far — because the free filter
 * already established there is one, and a page whose only mention is buried at
 * the bottom is exactly the page a naive head-slice would lose.
 */
const TRIAGE_HEAD = 1_200;
const TRIAGE_AROUND = 600;

export function triageExcerpt(text: string): string {
  const head = text.slice(0, TRIAGE_HEAD);
  const at = text.search(/تدريب|تعاون|متدرب|تمهير|co-?op|intern|trainee|training/i);
  if (at < 0 || at < TRIAGE_HEAD) return head;
  const from = Math.max(0, at - TRIAGE_AROUND / 2);
  return `${head}\n…\n${text.slice(from, from + TRIAGE_AROUND)}`;
}

export async function triage(text: string): Promise<TriageResult> {
  /*
   * The saving this stage buys is no longer money; it is the owner's CPU and
   * his patience with notifications. The bias is unchanged and is the whole
   * point: an unclear answer, an unreachable model, a timeout, a reply in prose
   * - every one of them passes the page on to be judged properly.
   *
   * `localTriage` enforces that, and `readsAsNo` there carries the corrected
   * Arabic word-boundary test that this function got wrong for weeks.
   */
  const result = await localTriage(triageExcerpt(text));
  return { looksLikeAnnouncement: result.looksLikeAnnouncement, usage: result.usage };
}

export async function classify(text: string, ask: Asker = liveAsk): Promise<ClassifyResult> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  /*
   * There is no credential to be missing any more, but there is still a model
   * that can be absent, and the failure has to stay just as loud.
   *
   * The stage name is kept as `no_credentials` because health.json, the app and
   * three tests already read it, and renaming a stored value to describe a new
   * cause is how a dataset stops meaning what it says. The reason string is
   * what a human reads, and it now names the real problem.
   *
   * The check is `ask === liveAsk` so injected test askers are never gated on a
   * model the test does not use.
   */
  if (ask === liveAsk) {
    const ready = await localModelReady();
    if (!ready.ok) {
      return {
        ok: false,
        stage: "no_credentials",
        reason: `the local model is not available, so nothing was classified: ${ready.reason}`,
        attempts: 0,
        usage,
      };
    }
  }
  if (ask === liveAsk && studentProfile() === null) {
    return {
      ok: false,
      stage: "no_profile",
      reason:
        "RASID_STUDENT_PROFILE is not set and .profile.local is missing; nothing was classified, because a verdict for the wrong student is worse than none",
      attempts: 0,
      usage,
    };
  }

  const excerpt = text.slice(0, MAX_EXCERPT_CHARS);
  let last: { stage: "api" | "parse" | "schema"; reason: string } = {
    stage: "api",
    reason: "not attempted",
  };

  // Spec section 5.3: one retry, with "Return valid JSON only." appended.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string;
    try {
      const reply = await ask(excerpt, attempt === 2);
      raw = reply.text;
      addUsage(usage, reply.usage);
    } catch (err) {
      /*
       * `liveAsk` no longer throws - an unreachable model comes back as text
       * that will not parse, which keeps the page queued and visible. This
       * branch remains for injected askers, which tests use to drive exactly
       * this failure, and for anything genuinely unexpected. A failed call is
       * still not an absence of news.
       */
      last = { stage: "api", reason: err instanceof Error ? err.message : String(err) };
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(unfence(raw));
    } catch {
      last = { stage: "parse", reason: `reply was not JSON: ${raw.slice(0, 160)}` };
      continue;
    }

    if (!validate(parsed)) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
        .join("; ");
      last = { stage: "schema", reason: `reply did not match the schema: ${detail}` };
      continue;
    }

    // An announcement without a title is not a reply we can store: the title
    // is what the user reads in the list. A non-announcement may omit it.
    const value = parsed as Classification;
    if (value.isTrainingAnnouncement && !value.titleAr?.trim()) {
      last = {
        stage: "schema",
        reason: "reply claims an announcement but gives no titleAr",
      };
      continue;
    }

    return { ok: true, value, attempts: attempt, usage };
  }

  return { ok: false, stage: last.stage, reason: last.reason, attempts: 2, usage };
}
