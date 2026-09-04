/**
 * The redactor removes paths and nothing else.
 *
 * It exists because thirty-three published rows carried the owner's Windows
 * account name. It is tested this hard because the first version of it, run
 * over the dataset, rewrote 478 source URLs into `http[…]/student-opportunities`
 * — the drive-letter pattern matched the `s:` of `https:` followed by `//`. A
 * redactor that damages the data it protects is worse than the leak it fixes,
 * so the second half of this file matters more than the first.
 *
 * The URLs are taken from the live dataset rather than invented, so the check is
 * against what the project actually holds.
 *
 *   npm run test:redact
 */
import { readFileSync } from "node:fs";
import { namesThisMachine, redactPaths } from "../src/pipeline/redact";
import type { Organisation } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("a local path is removed, and what it was is still readable");
{
  const cases: [string, string][] = [
    [
      "headless chromium unavailable (browserType.launch: Executable doesn't exist at C:\\Users\\Owner\\AppData\\Local\\ms-playwright\\chrome-headless-shell.exe)",
      "chrome-headless-shell.exe",
    ],
    ["ENOENT: no such file or directory, open 'D:/tools/node/node.exe'", "node.exe"],
    ["could not read /home/mesh/.config/rasid/state.json", "state.json"],
  ];
  for (const [message, keptTail] of cases) {
    const out = redactPaths(message);
    check(`redacted: ${message.slice(0, 44)}…`, !namesThisMachine(out), out.slice(0, 70));
    check("  and the useful tail survives", out.includes(keptTail), out.slice(0, 90));
  }
  check(
    "the account name is gone",
    !redactPaths(cases[0]![0]).includes("Owner"),
  );
}

console.log("\nand a URL is never touched");
{
  const orgs = JSON.parse(
    readFileSync("data/organisations.json", "utf8").replace(/^﻿/, ""),
  ) as Organisation[];
  const urls = orgs.flatMap((o) => o.sources.map((s) => s.url));
  check("the dataset has urls to check", urls.length > 300, `${urls.length} urls`);

  const damaged = urls.filter((u) => redactPaths(u) !== u);
  check(
    "not one of them is rewritten",
    damaged.length === 0,
    damaged.slice(0, 3).map((u) => `${u} -> ${redactPaths(u)}`).join(" ;; "),
  );

  const flagged = urls.filter((u) => namesThisMachine(u));
  check("and none of them is flagged as a local path", flagged.length === 0, flagged.slice(0, 3).join(" "));

  /*
   * The seeded fault: the pattern as it was first written, without the
   * lookbehind. If this ever stops matching, the lookbehind has been removed
   * and the URL damage is back.
   */
  const naive = /[A-Za-z]:[\\/]+(?:[^\s\\/:*?"<>|]+[\\/]+)*[^\s\\/:*?"<>|]*/;
  check(
    "the pattern without the lookbehind really does eat URLs (seeded fault)",
    naive.test("https://careers.sdaia.gov.sa/training"),
    "it matches the s:// of every https url, which is how 478 sources were rewritten",
  );
}

console.log("\nordinary prose is left alone");
{
  for (const text of [
    "التدريب التعاوني في الرياض",
    "HTTP 404",
    "robots.txt: could not reach robots.txt after 3 attempt(s)",
    "الصفحة تردّ 200 لكن عنوانها Error",
    "https://example.gov.sa/ar/Users/list",
  ]) {
    check(`unchanged: ${text.slice(0, 46)}`, redactPaths(text) === text, redactPaths(text));
  }
}

console.log("\nthe published dataset holds no path at all");
{
  const files = ["data/health.json", "data/organisations.json", "data/verification.json"];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    /*
     * Read as JSON strings, so the doubled backslashes a JSON file writes are
     * the ones a reader would actually see.
     */
    const decoded = JSON.stringify(JSON.parse(text.replace(/^﻿/, "")));
    const hit = /[A-Za-z]:\\\\Users\\\\|[A-Za-z]:\/Users\//.exec(decoded);
    check(f, hit === null, hit ? decoded.slice(Math.max(0, hit.index - 40), hit.index + 60) : "");
  }
}

console.log(`\n${failures === 0 ? "nothing personal, nothing damaged" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
