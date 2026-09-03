/**
 * The PowerShell entry points parse, and stay parseable.
 *
 * `scheduled-run.ps1` is how collection actually happens — the machine in
 * Riyadh is the only one that can reach most of these sites — and nothing in
 * the test suite ever looked at it. Two typographic dashes in a comment were
 * enough to stop it parsing, and the failure had the worst possible shape: the
 * task exited 1, nothing reached the log because the log is written from inside
 * the script, and the app went on showing a calm "checked N hours ago" while no
 * collection had run at all.
 *
 * Windows PowerShell 5.1 reads a `.ps1` with no byte-order mark in the system
 * codepage, so any character outside ASCII is a hazard rather than a style
 * choice. Both things are checked here: that the file parses, and that it
 * cannot acquire the characters that stop it parsing.
 *
 *   npm run test:scripts
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const dir = "scripts";
const shell = readdirSync(dir).filter((f) => f.endsWith(".ps1"));

console.log(`${shell.length} PowerShell script(s)\n`);

console.log("plain ASCII, because the parser depends on it");
for (const file of shell) {
  const text = readFileSync(join(dir, file), "utf8");
  const offenders = new Map<string, number>();
  for (const ch of text) {
    if (ch.codePointAt(0)! > 127) {
      offenders.set(ch, (offenders.get(ch) ?? 0) + 1);
    }
  }
  const shown = [...offenders]
    .map(([ch, n]) => `${JSON.stringify(ch)} U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} x${n}`)
    .join(", ");
  check(file, offenders.size === 0, shown);
}

/*
 * Parsed by PowerShell itself rather than by anything approximating it. The
 * abstract syntax tree is thrown away; only the error list matters.
 */
console.log("\nparses");
const isWindows = process.platform === "win32";
if (!isWindows) {
  console.log("  skipped: not running on Windows, and PowerShell 5.1 is the parser that matters");
} else {
  for (const file of shell) {
    const full = join(process.cwd(), dir, file).replace(/'/g, "''");
    const probe = `
      $errors = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile('${full}', [ref]$null, [ref]$errors)
      if ($errors) { $errors | ForEach-Object { "line " + $_.Extent.StartLineNumber + ": " + $_.Message } } else { "OK" }`;
    let out: string;
    try {
      out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probe],
        { encoding: "utf8", timeout: 60_000 },
      ).trim();
    } catch (err) {
      out = `could not run the parser: ${(err as Error).message}`;
    }
    check(file, out === "OK", out === "OK" ? "" : out.split("\n")[0]);
  }
}

/*
 * A rebase that stops on a conflict leaves the working tree holding files with
 * `<<<<<<<` in them, and the collector's own source is one of those files. The
 * scheduled run used to note the failure and collect anyway, which meant
 * importing a classifier that is no longer valid TypeScript: the round dies on
 * the first import and the app goes on saying it checked recently.
 *
 * This happened on this machine, so it is guarded rather than remembered.
 */
console.log("\na failed rebase can never be collected through");
{
  const run = readFileSync(join(dir, "scheduled-run.ps1"), "utf8");
  const afterPull = run.slice(run.indexOf("git pull --rebase"));
  const beforeCollect = afterPull.slice(0, afterPull.indexOf("npm run collect"));

  check(
    "the rebase is put back before anything else happens",
    /git rebase --abort/.test(beforeCollect),
  );
  check(
    "and the tree is checked, not assumed",
    /git ls-files --unmerged/.test(beforeCollect),
  );
  check(
    "a tree that is still conflicted stops the run instead of collecting",
    /unmerged[\s\S]{0,400}exit 1/.test(beforeCollect),
    "exiting non-zero is what makes the heartbeat go stale and the app turn red",
  );
}

/*
 * One line on stderr must not end the watcher.
 *
 * Windows PowerShell 5.1 wraps each stderr line of a native program in a
 * NativeCommandError record. Under `$ErrorActionPreference = "Stop"` that record
 * terminates, so `watch-run.ps1` caught it and exited 1 while the collector was
 * perfectly healthy. It has already happened once on this machine, and the cost
 * is total: no watcher means no rounds at all, and the app goes on showing the
 * last successful check as though nothing were wrong.
 *
 * Both halves are checked. The mechanism is run for real, so the gate rests on
 * PowerShell's behaviour rather than on a belief about it; and the file is read,
 * so the preference cannot quietly go back to Stop around the child.
 */
console.log("\none stderr line cannot kill the watcher");
{
  const src = readFileSync(join(dir, "watch-run.ps1"), "utf8");
  const atChild = src.slice(src.indexOf("watch.ts"));
  const beforeChild = src.slice(0, src.indexOf("watch.ts"));

  check(
    "the preference is lifted before the child is started",
    /\$ErrorActionPreference\s*=\s*"Continue"/.test(beforeChild),
  );
  check(
    "and restored afterwards, so Stop still governs the rest of the file",
    /finally\s*\{[\s\S]{0,200}\$ErrorActionPreference\s*=/.test(atChild),
  );
  check(
    "the child's exit code is still what the watcher reports",
    /\$LASTEXITCODE/.test(atChild),
  );

  if (!isWindows) {
    console.log("  skipped: the mechanism is PowerShell 5.1's, and this is not Windows");
  } else {
    /*
     * The seeded fault and the fix, side by side, against a child that prints
     * one line to stderr and exits 0 — exactly what node does on a warning.
     */
    const probe = (pref: string): string => {
      const script = `
        $ErrorActionPreference = "${pref}"
        try {
          & cmd.exe /c "echo out& echo err 1>&2& exit 0" 2>&1 | ForEach-Object { $null = [string]$_ }
          "SURVIVED:" + $LASTEXITCODE
        } catch { "KILLED" }`;
      try {
        return execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
          { encoding: "utf8", timeout: 60_000 },
        ).trim();
      } catch (err) {
        return `could not run the probe: ${(err as Error).message}`;
      }
    };

    check(
      "the old setting is genuinely fatal (seeded fault)",
      probe("Stop") === "KILLED",
      `Stop gave ${probe("Stop")}`,
    );
    const fixed = probe("Continue");
    check("the shipped setting survives it", fixed.startsWith("SURVIVED"), fixed);
    check("and the child's exit code came through as 0", fixed === "SURVIVED:0", fixed);
  }
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
