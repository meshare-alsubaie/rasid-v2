/**
 * Does the copied-wording guard refuse what the local model actually writes?
 *
 * `test:copied` proves the guard accepts the *stored* benchmark answers, and
 * those were produced by a much larger model that follows "copy this verbatim"
 * closely. llama3.1:8b may paraphrase instead. If it does, every page would be
 * refused and nothing would ever be scored again — a guard against invention
 * turning into an outage. That is worth measuring rather than assuming, and
 * this measures it against the real model on real fixtures.
 *
 *   npx tsx scripts/probe/guard-probe.ts 4
 */
import { CASES } from "../benchmark-cases";
import { classify, MAX_EXCERPT_CHARS, notCopiedFrom } from "../../src/pipeline/classify";

const n = Number(process.argv[2] ?? 4);
let accepted = 0;
let refusedByGuard = 0;
let otherFailure = 0;

for (const c of CASES.slice(0, n)) {
  const started = Date.now();
  const r = await classify(c.text);
  const secs = ((Date.now() - started) / 1000).toFixed(0);

  if (r.ok) {
    accepted++;
    const leftover = notCopiedFrom(c.text.slice(0, MAX_EXCERPT_CHARS), r.value);
    console.log(
      `  ok      ${c.id.padEnd(14)} ${secs}s  title=${JSON.stringify((r.value.titleAr ?? "").slice(0, 36))} leftover=${leftover.length}`,
    );
  } else if (r.reason.includes("wording the page does not")) {
    refusedByGuard++;
    console.log(`  GUARD   ${c.id.padEnd(14)} ${secs}s  ${r.reason.slice(0, 160)}`);
  } else {
    otherFailure++;
    console.log(`  fail    ${c.id.padEnd(14)} ${secs}s  ${r.stage}: ${r.reason.slice(0, 110)}`);
  }
}

console.log(
  `\naccepted ${accepted}, refused by the copy guard ${refusedByGuard}, other failures ${otherFailure}`,
);
process.exit(0);
