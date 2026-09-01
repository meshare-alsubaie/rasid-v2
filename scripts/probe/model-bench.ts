/**
 * Which free local model is allowed to stand where Claude stood.
 *
 * The paid classifier is being removed, so something has to read the pages
 * that survive the free filters. That thing runs on the owner's own machine
 * for nothing, and the only question worth asking about it is whether it ever
 * drops a real announcement. Cost is no longer a variable; a miss still costs
 * a semester.
 *
 * So the scoring here is deliberately lopsided:
 *
 *   RECALL on real announcements is pass/fail. Twenty out of twenty, or the
 *   model is disqualified. There is no partial credit and no threshold to
 *   move.
 *
 *   SPECIFICITY on ordinary pages is a comfort number. Every false positive
 *   costs one extra local inference and, at worst, one notification the owner
 *   glances at. That is the cheap direction and it is allowed to be bad.
 *
 * Errors and timeouts are scored as PASS, not as failures, because that is
 * what the pipeline itself must do: the free model is never permitted to deny.
 * A model that errors on every page therefore scores perfect recall and awful
 * specificity, which is exactly the shape of "useless but safe" and is
 * distinguishable in the output.
 *
 *   npx tsx scripts/probe/model-bench.ts
 *   npx tsx scripts/probe/model-bench.ts --models=qwen3:8b,gemma3:12b
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CASES } from "../benchmark-cases.js";

const HERE = join(process.cwd(), "scripts", "probe");
/*
 * OLLAMA_HOST is whatever the machine already had, and on this one it is
 * `0.0.0.0:11434` left over from another project: no scheme, and a bind
 * address rather than a destination. Both are legal for the server and neither
 * is a URL a client can fetch, so every call failed in fifteen milliseconds
 * and the contract dutifully passed all twenty-eight samples through. Recall
 * read 20/20 on a model that had not been asked a single question.
 *
 * That is precisely the failure this project exists to refuse, so the value is
 * repaired here rather than trusted, and the environment is left alone.
 */
function ollamaBase(): string {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return "http://127.0.0.1:11434";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  // 0.0.0.0 means "listen everywhere"; as a destination it means nothing.
  return withScheme.replace("//0.0.0.0", "//127.0.0.1").replace(/\/+$/, "");
}
const OLLAMA = ollamaBase();

const arg = (name: string, fallback: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const MODELS = arg("models", "qwen3:8b,gemma3:12b,gemma3:4b,llama3.1:8b").split(",");
const TIMEOUT_MS = Number(arg("timeout", "180000"));

/**
 * The triage question, and nothing else.
 *
 * It asks only whether the page is worth a closer look. It does not ask for a
 * score, a date conversion, or a judgement about the reader: scores moved to
 * the browser, dates are converted in code against Umm al-Qura, and neither is
 * a thing to leave to an eight-billion-parameter model running on a desktop.
 *
 * The instruction to answer "نعم" when unsure is the contract, written where
 * the model reads it rather than only in the code that calls it.
 */
const TRIAGE_SYSTEM = `أنت فارز صفحات. مهمّتك سؤال واحد فقط:
هل يمكن أن تحتوي هذه الصفحة على إعلان تدريب تعاوني أو تدريب جامعي أو تمهير أو برنامج تدريب لطلاب؟

قواعد مُلزمة:
- عند أي شكّ، أو نقص معلومة، أو غموض: أجب true.
- لا تحكم على جودة الفرصة ولا على مناسبتها لأحد.
- لا تحوّل تواريخ ولا تحسب شيئاً.
- أجب بـJSON فقط بهذا الشكل حرفياً: {"candidate": true} أو {"candidate": false}`;

interface Sample {
  id: string;
  text: string;
  /** True when a real announcement is present and the model must pass it on. */
  isAnnouncement: boolean;
}

interface Outcome {
  id: string;
  expected: boolean;
  /** What the pipeline would actually do: an error is a pass, by contract. */
  passedOn: boolean;
  raw: string | null;
  errored: boolean;
  ms: number;
}

/** Thinking models wrap their reasoning; the answer is what is left after it. */
const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

function readCandidate(body: string): boolean | null {
  const text = stripThinking(body);
  const match = /\{[\s\S]*?"candidate"\s*:\s*(true|false)[\s\S]*?\}/i.exec(text);
  if (match) return match[1].toLowerCase() === "true";
  // Some models answer the question in prose despite the instruction.
  if (/^\s*(true|نعم)\b/i.test(text)) return true;
  if (/^\s*(false|لا)\b/i.test(text)) return false;
  return null;
}

async function triage(model: string, sample: Sample): Promise<Outcome> {
  const started = Date.now();
  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        system: TRIAGE_SYSTEM,
        prompt: sample.text.slice(0, 6000),
        stream: false,
        // Thinking is latency this job cannot spend and does not need.
        think: false,
        format: "json",
        options: {
          // The GPU belongs to the games. Every measurement here is the CPU
          // path, because that is the path this will actually run on.
          num_gpu: 0,
          temperature: 0,
          num_predict: 40,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as { response?: string; error?: string };
    const ms = Date.now() - started;
    if (json.error) return { id: sample.id, expected: sample.isAnnouncement, passedOn: true, raw: json.error, errored: true, ms };

    const verdict = readCandidate(json.response ?? "");
    return {
      id: sample.id,
      expected: sample.isAnnouncement,
      // Unparseable is undecided, and undecided passes on. Never a silent no.
      passedOn: verdict === null ? true : verdict,
      raw: (json.response ?? "").slice(0, 120),
      errored: verdict === null,
      ms,
    };
  } catch (err) {
    return {
      id: sample.id,
      expected: sample.isAnnouncement,
      passedOn: true,
      raw: err instanceof Error ? err.message : String(err),
      errored: true,
      ms: Date.now() - started,
    };
  }
}

function loadSamples(): Sample[] {
  const positives: Sample[] = CASES.filter((c) => c.expect.isTrainingAnnouncement).map((c) => ({
    id: c.id,
    text: c.text,
    isAnnouncement: true,
  }));

  const negPath = join(HERE, "negatives.json");
  if (!existsSync(negPath)) {
    console.error(`missing ${negPath}. Run: npx tsx scripts/probe/build-negatives.ts`);
    process.exit(2);
  }
  const negatives: Sample[] = (JSON.parse(readFileSync(negPath, "utf8")) as { id: string; text: string }[]).map((n) => ({
    id: n.id,
    text: n.text,
    isAnnouncement: false,
  }));

  return [...positives, ...negatives];
}

async function main(): Promise<void> {
  const samples = loadSamples();
  const pos = samples.filter((s) => s.isAnnouncement).length;
  const neg = samples.length - pos;
  console.log(`samples : ${pos} announcements + ${neg} ordinary pages`);
  console.log(`models  : ${MODELS.join(", ")}`);
  console.log(`device  : CPU only (num_gpu=0)\n`);

  const report: Record<string, unknown> = { ranAtISO: new Date().toISOString(), samples: { pos, neg }, models: {} };

  for (const model of MODELS) {
    const outcomes: Outcome[] = [];
    for (const s of samples) outcomes.push(await triage(model, s));

    const announcements = outcomes.filter((o) => o.expected);
    const ordinary = outcomes.filter((o) => !o.expected);
    const missed = announcements.filter((o) => !o.passedOn);
    const falseAlarms = ordinary.filter((o) => o.passedOn);
    const times = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] ?? 0;
    const errors = outcomes.filter((o) => o.errored).length;

    /*
     * A model that was never reached must not read as a model that passed.
     *
     * The first run of this file scored gemma3:4b at 20/20 recall while every
     * one of its twenty-eight calls had failed on a malformed host address.
     * The contract is right - an error passes the page on - but applying it to
     * a measurement turns "we could not ask" into "it answered perfectly",
     * which is a number that improves because we stopped measuring. So the
     * error rate gates the verdict, and a mostly-failed run reports as
     * unmeasured no matter how the arithmetic came out.
     */
    const verdict =
      errors > outcomes.length * 0.2 ? "NOT_MEASURED" : missed.length === 0 ? "ELIGIBLE" : "DISQUALIFIED";
    console.log(`${model}`);
    console.log(`  recall      ${announcements.length - missed.length}/${announcements.length}  ${verdict}${missed.length ? "  missed: " + missed.map((m) => m.id).join(",") : ""}`);
    console.log(`  specificity ${ordinary.length - falseAlarms.length}/${ordinary.length}  (false alarms are cheap)`);
    console.log(`  median      ${(median / 1000).toFixed(1)}s per page on CPU`);
    console.log(`  slowest     ${((times.at(-1) ?? 0) / 1000).toFixed(1)}s`);
    console.log(`  errors      ${errors}\n`);

    (report.models as Record<string, unknown>)[model] = {
      verdict,
      recall: `${announcements.length - missed.length}/${announcements.length}`,
      missed: missed.map((m) => m.id),
      specificity: `${ordinary.length - falseAlarms.length}/${ordinary.length}`,
      falseAlarms: falseAlarms.map((f) => f.id),
      medianMs: median,
      slowestMs: times.at(-1) ?? 0,
      errors,
      outcomes,
    };
  }

  mkdirSync(join(HERE, "results"), { recursive: true });
  const path = join(HERE, "results", "model-bench.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`-> ${path}`);
  // A model failing is a measurement, not a broken run.
  process.exit(0);
}

main().catch((err) => {
  console.error("bench crashed:", err);
  process.exit(1);
});
