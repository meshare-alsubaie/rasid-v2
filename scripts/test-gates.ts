/**
 * The checkers are themselves checked.
 *
 * Twice now a gate has passed while checking nothing. `tsconfig.app.json`
 * inherited an `exclude` that cancelled its own `include`, so the entire
 * browser half of the application went unchecked for the whole build and a
 * syntax error reached a pushed commit. And the privacy scanner read only
 * tracked files, so a generated fixture carrying the owner's project name was
 * committed before anything looked at it.
 *
 * Both failures had the same shape: a green tick from a tool that was not
 * looking. The only defence is to make the tool fail on demand — plant a fault
 * it must catch, and assert that it does.
 *
 *   npm run test:gates
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Runs an npm script and reports whether it failed, never throwing.
 *
 * Everything goes through npm rather than through the tools directly. The first
 * version of this ran `npx tsc`, which does not launch on Windows the way it
 * does elsewhere — so every command "failed", and a test asserting that a
 * planted fault is caught passed for the wrong reason. A harness that cannot
 * tell a caught fault from a failed launch is the same bug it was written to
 * prevent, which is why each case below also asserts the clean state passes.
 */
function run(script: string): { code: number; out: string } {
  try {
    const out = execFileSync(npm, ["run", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Node refuses to execute a .cmd shim without a shell, and every npm on
      // Windows is one. Without this every command "fails" and a test that
      // asserts a fault is caught passes for the wrong reason.
      shell: process.platform === "win32",
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

console.log("the type checker actually reaches the browser code");
{
  const probe = "src/app/gate-probe.ts";
  writeFileSync(probe, 'export const wrong: number = "a string, deliberately";\n', "utf8");
  const before = run("typecheck");
  rmSync(probe);
  const after = run("typecheck");

  check(
    "a planted type error in src/app fails the check",
    before.code !== 0,
    before.code === 0 ? "IT PASSED — src/app is not being checked" : "",
  );
  check(
    "and the error names the file",
    /gate-probe/.test(before.out),
    before.out.split("\n").find((l) => l.includes("error")) ?? "no error text",
  );
  check("removing it makes the check pass again", after.code === 0);
}

console.log("\nthe privacy scanner reaches a file that is not committed yet");
{
  /*
   * The exact hole that let a leak through: `git ls-files` lists tracked files
   * only, so anything newly generated was invisible until after it had been
   * committed — which is the one moment when catching it still costs nothing.
   */
  if (!existsSync("data")) mkdirSync("data");
  const probe = "data/gate-probe.json";
  writeFileSync(probe, JSON.stringify({ note: "First Class Honours" }) + "\n", "utf8");
  const untracked = run("audit:privacy");
  rmSync(probe);
  const clean = run("audit:privacy");

  check(
    "an untracked file carrying a personal detail is caught",
    untracked.code !== 0,
    untracked.code === 0 ? "IT PASSED — only tracked files are scanned" : "",
  );
  check("and the report names it", /gate-probe/.test(untracked.out));
  check("removing it makes the scan clean again", clean.code === 0);
}

console.log("\nthe validator refuses a dataset that breaks an honesty rule");
{
  const path = "data/opportunities.json";
  // Read from disk, not from git: the working tree is what the validator is
  // about to judge, and restoring an older revision over it would leave the
  // dataset inconsistent with the health and snapshot files beside it.
  const original = readFileSync(path, "utf8");
  const records = JSON.parse(original) as Record<string, unknown>[];
  // "Open now" with no date behind it: the worst false state the app can hold.
  records.push({
    ...(records[0] ?? {}),
    id: "gateprobe0000000",
    status: "open",
    opensISO: null,
    closesISO: null,
    flags: [],
  });
  writeFileSync(path, JSON.stringify(records, null, 2) + "\n", "utf8");
  const broken = run("validate");
  writeFileSync(path, original, "utf8");
  const restored = run("validate");

  check(
    "a window open with no published date is rejected",
    broken.code !== 0,
    broken.code === 0 ? "IT PASSED — the rule is not enforced" : "",
  );
  check("and it is named as such", /open_without_dates/.test(broken.out));
  check("restoring the file makes it pass again", restored.code === 0);
}

console.log("\nthe PowerShell check catches a file the shell cannot read");
{
  /*
   * PowerShell 5.1 reads an unmarked `.ps1` in the system codepage, so a single
   * Arabic character in a comment turns the whole file into a parse error and
   * collection silently stops. That is a failure nobody sees until the phone
   * has been quiet for a week, which is why it is a gate and not a habit.
   */
  const probe = "scripts/gate-probe.ps1";
  writeFileSync(probe, "# تعليق بالعربية\nWrite-Output 'x'\n", "utf8");
  const seeded = run("test:scripts");
  rmSync(probe);
  const clean = run("test:scripts");

  check(
    "a non-ASCII byte in a .ps1 is caught",
    seeded.code !== 0,
    seeded.code === 0 ? "IT PASSED — the shell files are not being read" : "",
  );
  check("and the report names the file", /gate-probe/.test(seeded.out));
  check("removing it makes the check pass again", clean.code === 0);
}

console.log("\nthe domain audit catches an organisation watched on somebody else's site");
{
  /*
   * On a fixture, not on the real dataset: planting this in
   * `data/organisations.json` would mean rewriting half a megabyte that a
   * collection round may be holding open, to test a rule about correctness.
   */
  const probe = "data/gate-probe-orgs.json";
  const src = (url: string) => ({
    url,
    provenance: "manual" as const,
    verifiedAtISO: "2026-01-01T00:00:00.000Z",
    verifiedNote: "fixture",
    type: "careers_page" as const,
    checkFrequencyHours: 24,
    renderMode: "static" as const,
  });
  const org = (id: string, urls: string[]) => ({
    id,
    nameAr: id,
    tier: "A",
    sector: "gov",
    sources: urls.map(src),
  });
  writeFileSync(
    probe,
    JSON.stringify(
      [
        org("alpha", ["https://alpha.gov.sa/coop", "https://alpha.gov.sa/careers"]),
        org("beta", ["https://alpha.gov.sa/beta-coop"]),
      ],
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const seeded = run("audit:domains -- --file data/gate-probe-orgs.json");
  rmSync(probe);
  const clean = run("audit:domains");

  check(
    "an organisation with no source of its own is caught",
    seeded.code !== 0,
    seeded.code === 0 ? "IT PASSED — the rule is not enforced" : "",
  );
  check("and it is named", /beta/.test(seeded.out), seeded.out.split("\n").slice(-6).join(" | ").slice(0, 90));
  check("the real dataset still passes", clean.code === 0);
}

/*
 * Every gate in the chain has a way to fail.
 *
 * The three faults above are planted from outside, which only works on a gate
 * that reads a file. Most of them build their own fixtures in memory, and there
 * is no honest way to seed those without rewriting them — but the failure that
 * actually happened twice is cruder than a subtle wrong assertion: a script
 * that prints its findings and exits zero regardless. `audit:domains` was
 * exactly that until today; it printed an organisation watched on the wrong
 * site, every run, and nothing ever went red.
 *
 * So this reads the chain out of package.json and checks each member has a
 * non-zero exit path and a failure counter feeding it. Cheap, static, and it
 * catches the shape of the bug rather than one instance of it.
 */
console.log("\nevery gate in the chain can go red at all");
{
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const chain = [...(pkg.scripts.gates ?? "").matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]!);
  check("the chain was read from package.json", chain.length > 10, `${chain.length} gates`);

  const NO_SOURCE = new Set(["typecheck"]); // tsc's own exit code, not ours
  for (const name of chain) {
    if (NO_SOURCE.has(name)) continue;
    const cmd = pkg.scripts[name] ?? "";
    const file = /tsx (scripts\/[\w.-]+)/.exec(cmd)?.[1];
    if (!file || !existsSync(file)) {
      check(`${name}: its source was found`, false, cmd);
      continue;
    }
    const src = readFileSync(file, "utf8");
    const canFail = /process\.exit\([^)]*[?:][^)]*1\)|process\.exit\(1\)/.test(src);
    check(`${name}: exits non-zero on a finding`, canFail, canFail ? "" : "it can only ever print");
  }
}

console.log(`\n${failures === 0 ? "every gate fails when it should" : `${failures} GATE(S) DO NOT CATCH WHAT THEY CLAIM TO`}`);
process.exit(failures === 0 ? 0 : 1);
