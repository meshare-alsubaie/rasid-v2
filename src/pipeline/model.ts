/**
 * The model, running on the owner's own machine, for nothing.
 *
 * This replaces a paid API call with a local one and changes nothing else. The
 * parsing, the schema check, the retry, the cross-field validation in
 * classify.ts are all hard-won and all stay: `classify` already takes an
 * `Asker` seam, so the only thing swapped here is who answers.
 *
 * Two constraints shape every option below, and neither is negotiable.
 *
 * THE GPU BELONGS TO THE GAMES. `num_gpu: 0` pins inference to the CPU. The
 * machine has an RTX 4060 Ti with 8 GB, and an eight-billion-parameter model
 * would take five of them; League of Legends would keep running and would keep
 * stuttering, and the owner would be left guessing why. An i5-13400F with
 * sixteen threads and 32 GB of RAM does this job in seconds, and the graphics
 * card is never asked.
 *
 * A FREE MODEL MAY NOT DENY. Every failure path in this file returns "yes, look
 * closer" rather than "no". A timeout, a dead server, an unparseable reply, a
 * model that was never pulled: all of them pass the page on. Being wrong that
 * way costs one more local inference. Being wrong the other way costs a
 * semester, and it is silent.
 */
import type { Usage } from "./classify.js";

/**
 * Where Ollama is listening, repaired rather than trusted.
 *
 * On this machine OLLAMA_HOST is `0.0.0.0:11434`, left over from another
 * project: no scheme, and a bind address rather than a destination. Both are
 * legal for the server and neither is a URL a client can fetch. Read raw, every
 * request failed in fifteen milliseconds, and because a failure means "pass the
 * page on", a benchmark scored a model 20/20 on twenty-eight questions it had
 * never been asked. The environment is left alone; the value is fixed here.
 */
export function ollamaBase(): string {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return "http://127.0.0.1:11434";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace("//0.0.0.0", "//127.0.0.1").replace(/\/+$/, "");
}

/**
 * Chosen by measurement, not by reputation. See scripts/probe/model-bench.ts.
 *
 * Four models, twenty real announcements and eight ordinary ministry pages, all
 * on this machine's CPU. Every one of them passed all twenty announcements,
 * which is the requirement; they differed only in how much ordinary traffic
 * they waved through:
 *
 *   llama3.1:8b   20/20 recall   6/8 ordinary pages correctly dropped   2.7s
 *   qwen3:8b      20/20          3/8                                    3.0s
 *   gemma3:12b    20/20          2/8                                    8.6s
 *   gemma3:4b     20/20          1/8                                    2.5s
 *
 * That table measured the wrong thing, and the wrong model won because of it.
 *
 * Every column above is about **triage**: the one-word question, where the only
 * output is yes or no and no Arabic has to be written. llama3.1 does drop more
 * noise there. But triage is the cheap half. The expensive half asks the model
 * to copy seventeen fields *off the page, verbatim*, and nobody measured that
 * at all — so the model was chosen on a test that could not see the thing it
 * would spend all its time doing.
 *
 * Measured directly, on the same fixtures, with the guard that checks a claimed
 * copy against the text it was shown:
 *
 *   llama3.1:8b   0 of 3 accepted     titles: "الياعلان الثدرب الإعاني",
 *                                             "الحداب الاشية الإليكي"
 *   qwen3:8b     10 of 10 accepted    titles: "برنامج التدريب التعاوني بسدايا",
 *                                             "تدريب تعاوني — تحليل البيانات"
 *
 * Those llama strings are not words. They are the same shape as the invented
 * records the audit found in the live data — a 90 on the national cybersecurity
 * academy for "البراغات الالميدية", a 0 on a bank for a title that reads as
 * nothing — and they are not a tuning problem. An 8B model that cannot write
 * Arabic cannot do this job, however well it answers yes and no.
 *
 * qwen3 was also faster on the real work: 33 seconds a page against 68 to 105.
 * It drops less noise at triage, so more pages reach the full question; that
 * costs processor time, and processor time is the resource this project has.
 * Invented records cost the thing it does not have, which is trust in a number.
 */
export const LOCAL_MODEL = process.env.RASID_LOCAL_MODEL?.trim() || "qwen3:8b";

/**
 * Generous, because slow is not broken.
 *
 * A twelve-billion-parameter model on a CPU can spend a minute on a long page.
 * Cutting it short would be read as a failure, and a failure passes the page
 * on, so a mean timeout does not lose announcements - it just quietly turns the
 * model off and floods the next stage. Better to wait.
 */
const TIMEOUT_MS = Number(process.env.RASID_LOCAL_TIMEOUT_MS ?? 180_000);

/** Thinking models wrap their reasoning; the answer is what is left after it. */
export const stripThinking = (s: string): string =>
  s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

interface OllamaReply {
  response?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export interface LocalCall {
  text: string;
  usage: Usage;
  /** Null when the model answered. A string when it could not be reached. */
  error: string | null;
  ms: number;
}

/**
 * One call. Never throws: the caller's decision must not depend on ours.
 *
 * `json` asks Ollama to constrain the output to valid JSON. It is worth using
 * for the seventeen-field verdict and worth avoiding for the one-word triage,
 * where it costs latency for a shape that is trivial to read anyway.
 */
export async function askLocal(opts: {
  system: string;
  prompt: string;
  json: boolean;
  maxTokens: number;
  model?: string;
}): Promise<LocalCall> {
  const started = Date.now();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const res = await fetch(`${ollamaBase()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model ?? LOCAL_MODEL,
        system: opts.system,
        prompt: opts.prompt,
        stream: false,
        // Reasoning traces are latency this job cannot spend and does not need.
        think: false,
        ...(opts.json ? { format: "json" } : {}),
        options: { num_gpu: 0, temperature: 0, num_predict: opts.maxTokens },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      return { text: "", usage, error: `ollama HTTP ${res.status}`, ms: Date.now() - started };
    }
    const json = (await res.json()) as OllamaReply;
    if (json.error) {
      return { text: "", usage, error: json.error, ms: Date.now() - started };
    }

    /*
     * Counted, though nothing is charged for it.
     *
     * The tokens are kept because the run report still needs a number for the
     * work done, and because a stage that suddenly stops producing tokens is a
     * stage that has quietly stopped running. What changed is the unit: money
     * is no longer the thing to report, since there is no longer a bill. Time
     * is, and the caller sums `ms`.
     */
    usage.inputTokens = json.prompt_eval_count ?? 0;
    usage.outputTokens = json.eval_count ?? 0;

    return {
      text: stripThinking(json.response ?? ""),
      usage,
      error: null,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      text: "",
      usage,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    };
  }
}

export interface LocalTriage {
  looksLikeAnnouncement: boolean;
  usage: Usage;
  ms: number;
  /** Set when the model could not be asked. The page passes on regardless. */
  error: string | null;
}

/**
 * The sorting question, and the only one the free model is trusted with alone.
 *
 * It decides whether a page is worth a fuller reading. It is never allowed to
 * end a page's life: a "no" here means "not worth the longer look", and the
 * instruction to answer yes when unsure is written into the prompt as well as
 * enforced in the code, because both readers matter.
 */
/**
 * The one-word question, and the one case it kept getting wrong.
 *
 * A graduate-development programme is not what this reader wants, and it must
 * still get past this stage. The app has a state for it — scored zero, marked
 * `wrong_product` — which tells him the programme exists and is not for him;
 * dropped here instead, he is told nothing and the page is never read again.
 * The gate caught the newer model ruling one out, so the question now names
 * graduates explicitly rather than relying on "when in doubt, say true" to
 * cover a case the wording had excluded.
 */
const TRIAGE_SYSTEM = `أنت فارز صفحات. سؤالك واحد فقط:
هل يمكن أن تحتوي هذه الصفحة على إعلان تدريب تعاوني أو تدريب جامعي أو تمهير أو
برنامج تدريب لطلاب أو خرّيجين، بما في ذلك برامج تطوير الخرّيجين والتوظيف
المنتهي بالتوظيف؟

قواعد مُلزمة:
- عند أي شكّ، أو نقص معلومة، أو غموض: أجب true.
- برنامج للخرّيجين هو إعلان، حتى لو لم يكن تدريباً تعاونياً. أجب true.
- لا تحكم على جودة الفرصة ولا على مناسبتها لأحد.
- لا تحوّل تواريخ ولا تحسب شيئاً.
- أجب بـJSON فقط: {"candidate": true} أو {"candidate": false}`;

/**
 * Read a yes or a no out of whatever came back, and treat anything else as yes.
 *
 * Note the Arabic no is matched without a trailing `\b`. A word boundary in
 * JavaScript is defined against [A-Za-z0-9_], so the position after لا is only
 * a boundary when a Latin character follows. `/^\s*(لا|no)\b/` therefore never
 * matched a bare Arabic "لا", every Arabic no was read as a yes, and the filter
 * saved nothing while appearing to work. The boundary belongs inside the
 * alternation, on the English branch alone.
 */
export function readsAsNo(answer: string): boolean {
  const text = stripThinking(answer);
  const json = /\{[\s\S]*?"candidate"\s*:\s*(true|false)[\s\S]*?\}/i.exec(text);
  if (json) return json[1]!.toLowerCase() === "false";
  /*
   * The Arabic branch needs a boundary of its own, and had none.
   *
   * `\b` was correctly moved off the Arabic alternative, because a word
   * boundary between two Arabic letters never matches and the guard would never
   * have fired. But nothing replaced it, so the pattern matched the *letters*
   * lam-alif at the start of any sentence — and Arabic has a great many words
   * that begin that way. Every one of these was read as "no", and the page was
   * dropped:
   *
   *   "لا شك أنها إعلان تدريب تعاوني"     no doubt this is a coop announcement
   *   "لاحظ أن الصفحة تحتوي إعلان تدريب"   note that the page contains one
   *   "لابد من مراجعة الصفحة"              the page must be reviewed
   *
   * The last one inverts the instruction the prompt itself gives, which is to
   * say yes when unsure.
   *
   * A letter boundary is not enough either, because the two hardest cases put a
   * space after it: in "لا شك" and "لا أستطيع" the word does mean "no", but it
   * is negating the *next* word rather than answering the question. So the rule
   * follows the contract instead of the grammar. The prompt asks for one word.
   * A bare "لا", or one followed by punctuation, is that word. A "لا" that runs
   * on into a sentence is not an answer we were promised, and the documented
   * default for anything we cannot read is to let the page through.
   */
  return /^\s*(?:لا\s*(?:[.،,!؟]|$)|no\b|false)/iu.test(text);
}

export async function localTriage(excerpt: string): Promise<LocalTriage> {
  const call = await askLocal({
    system: TRIAGE_SYSTEM,
    prompt: excerpt,
    json: true,
    maxTokens: 40,
  });

  if (call.error !== null) {
    // Unreachable is not a no. It is not an answer at all.
    return { looksLikeAnnouncement: true, usage: call.usage, ms: call.ms, error: call.error };
  }
  return {
    looksLikeAnnouncement: !readsAsNo(call.text),
    usage: call.usage,
    ms: call.ms,
    error: null,
  };
}

/**
 * Is the local model actually there?
 *
 * Called once at the start of a round so the answer is a line in the report
 * rather than a hundred identical failures. A missing model is a loud,
 * recorded degradation: pages are still fetched, hashes are still stored, and
 * nothing is judged - which is exactly what should happen, and exactly what the
 * owner must be told happened.
 */
export async function localModelReady(model = LOCAL_MODEL): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, reason: `ollama answered HTTP ${res.status}` };
    const json = (await res.json()) as { models?: { name?: string }[] };
    const names = (json.models ?? []).map((m) => m.name ?? "");
    if (!names.includes(model)) {
      return { ok: false, reason: `"${model}" is not installed. Have: ${names.join(", ") || "none"}` };
    }
    return { ok: true, reason: `${model} on ${ollamaBase()}` };
  } catch (err) {
    return {
      ok: false,
      reason: `ollama is not reachable at ${ollamaBase()} (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
