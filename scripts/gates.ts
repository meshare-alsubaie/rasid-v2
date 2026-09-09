/**
 * Run every gate, then say what the state is.
 *
 * `gates` was a chain of twenty-one `npm run` calls joined by `&&`, which means
 * the first failure hides everything behind it. On 2026-09-09 `audit:privacy`
 * went red at position three and eighteen gates did not run at all - and the
 * chain still printed "1 match(es)" and exited 1, so it looked like one problem
 * when it was one problem and eighteen unknowns.
 *
 * That is the worse failure. A gate that is red for a reason someone has already
 * decided to live with turns the whole suite off, silently, for as long as the
 * decision takes.
 *
 * So every gate runs, always, and the exit code is still zero only if every one
 * of them passed. Nothing is weakened: the same gates, the same rules, the same
 * verdict. What changes is that a red gate can no longer take the other twenty
 * with it.
 *
 *   npm run gates
 *
 * The order is still read out of `gates:chain` in package.json, which remains a
 * runnable script for when fail-fast is what you want.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const all = [...(pkg.scripts["gates:chain"] ?? "").matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]!);

// A subset can be named, which is how the seeded-fault suite proves this runner
// reports a failure instead of swallowing it:
//
//   npm run gates -- typecheck test:arabic
const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const unknown = asked.filter((a) => !all.includes(a));
if (unknown.length > 0) {
  console.error(`gates: not in the chain: ${unknown.join(", ")}`);
  process.exit(1);
}
const chain = asked.length > 0 ? asked : all;

if (chain.length === 0) {
  console.error("gates: `gates:chain` in package.json names no gates. Nothing was checked.");
  process.exit(1);
}

interface Result {
  name: string;
  code: number;
  seconds: number;
  tail: string;
}

const results: Result[] = [];
const started = Date.now();

console.log(`${chain.length} gates\n`);

for (const [i, name] of chain.entries()) {
  const at = Date.now();
  process.stdout.write(`  ${String(i + 1).padStart(2)}/${chain.length}  ${name.padEnd(18)}`);

  const run = spawnSync(npm, ["run", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Node will not execute a .cmd shim without a shell, and every npm on
    // Windows is one.
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });

  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const code = run.status ?? 1;
  const seconds = (Date.now() - at) / 1000;
  results.push({
    name,
    code,
    seconds,
    // The last lines are where a gate says what it found; npm's own "ERR!"
    // preamble is noise that repeats the exit code we already have.
    tail: out
      .split("\n")
      .filter((l) => l.trim() !== "" && !/^npm (ERR!|error)/.test(l))
      .slice(-6)
      .join("\n"),
  });

  console.log(`${code === 0 ? "pass" : "FAIL"}  ${seconds.toFixed(0)}s`);
}

const failed = results.filter((r) => r.code !== 0);

for (const r of failed) {
  console.log(`\n${r.name} failed:`);
  for (const line of r.tail.split("\n")) console.log(`    ${line}`);
}

const minutes = ((Date.now() - started) / 60_000).toFixed(1);
console.log(
  failed.length === 0
    ? `\nall ${chain.length} gates passed in ${minutes} minutes`
    : `\n${failed.length} of ${chain.length} gates failed in ${minutes} minutes: ${failed
        .map((r) => r.name)
        .join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
