/**
 * Refuse to publish a person.
 *
 * This repository is public and is meant to be shown to recruiters. It is
 * about organisations; exactly one thing in it is about its owner, and that
 * belongs in `.profile.local` and a repository secret, never in a commit.
 *
 * Git remembers. A personal detail pushed once is public even after it is
 * deleted, so this runs before the push and not after: it scans every tracked
 * file and exits non-zero on a match.
 *
 *   npm run audit:privacy
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Rule {
  name: string;
  pattern: RegExp;
  why: string;
  /** Files where a match is expected and harmless. */
  allow?: RegExp;
}

const RULES: Rule[] = [
  {
    /*
     * The owner's own machine, which is not a person but is just as personal.
     *
     * Thirty-three rows of `data/health.json` were published carrying
     * `C:\Users\GIGABITE\AppData\Local\ms-playwright\...` — the Windows account
     * name, on a public URL, in a file nobody thinks of as prose. It got there
     * because an error message from a library was stored verbatim, and this
     * gate did not look for filesystem paths at all.
     *
     * The scripts that *use* these paths are allowed to name them: an installer
     * that must say where node lives is not a leak. A committed data file is.
     */
    name: "a local filesystem path",
    pattern: /[A-Za-z]:[\\/]{1,2}Users[\\/]|\\\\\\\\[^\s\\]+\\\\|\/(?:home|Users)\/[a-z]/gi,
    why: "the dataset is served from a public URL, and a path names the account it belongs to",
    allow: /^(?:scripts\/|\.claude\/|.*\.md$|.*\.ps1$|src\/pipeline\/redact\.ts$)/,
  },
  {
    name: "personal email",
    // Anything that is not an organisation's published contact address. Those
    // are business addresses that belong in the dataset; a personal mailbox
    // does not.
    pattern: /\b[\w.+-]+@(?:gmail|hotmail|outlook|yahoo|icloud|proton(?:mail)?)\.[a-z.]+/gi,
    why: "a personal mailbox in a public repository is scraped within days",
  },
  {
    name: "grade point average",
    pattern: /\bGPA\s*[:\s]*\d|معدل\s+المستخدم|معدل\s+الطالب\s*\d/g,
    why: "the owner's grades are not part of a tool about organisations",
    /*
     * An organisation's own published minimum is a fact about that
     * organisation, and quoting it is the evidence this whole dataset rests on:
     * Al Rajhi's "Minimum cumulative GPA 3 out of 4" is the proof that its page
     * really is the co-op page. Deleting the quote to satisfy a privacy rule
     * about the owner's grades would remove proof to hide nothing.
     *
     * verification.json is the record of what was read on each page, so it is
     * allowed here for the same reason the other two data files are. The rule
     * still guards every file where the owner's own grade could appear —
     * source, workflows, README, the profile example.
     */
    allow: /^data\/(organisations|opportunities|verification)\.json$/,
  },
  {
    name: "personal credentials",
    pattern: /First Class Honours|Security\+\s*certified|Zero-Trust SOC/g,
    why: "identifies the owner; belongs in the profile secret",
  },
  {
    name: "personal circumstances",
    pattern: /سكن مجاني|free accommodation|evening lecture courses/g,
    why: "describes the owner's life, not an organisation",
    allow: /^\.profile\.example$/,
  },
];

/*
 * This file is skipped, because a scanner necessarily contains the strings it
 * scans for. Skipping it is the only honest option: weakening the patterns so
 * they do not match here would weaken them everywhere else too.
 */
/*
 * And the test that proves this scanner works, for the same reason: it plants a
 * personal detail on purpose and asserts that the scan catches it, so it cannot
 * help but contain one. Skipping exactly these two files is the honest option —
 * weakening the patterns until they stopped matching here would weaken them
 * everywhere the patterns actually matter.
 */
const SELF = ["scripts/audit-privacy.ts", "scripts/test-gates.ts"];

/*
 * Everything tracked, and everything about to be. `git ls-files` alone misses
 * a file staged for its first commit, which is precisely when a leak is easiest
 * to stop and hardest to notice — a generated fixture that had never existed
 * before carried the owner's project name into a public repository that way,
 * and was only caught on the run after it was committed.
 */
const listed = (args: string[]): string[] =>
  execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);

const files = [...new Set([...listed(["ls-files"]), ...listed(["ls-files", "--others", "--exclude-standard"])])]
  .filter((f) => !SELF.includes(f))
  .sort();

let hits = 0;
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary, such as the icons
  }
  for (const rule of RULES) {
    if (rule.allow?.test(file)) continue;
    const found = text.match(rule.pattern);
    if (!found) continue;
    hits += found.length;
    const line = text.slice(0, text.indexOf(found[0]!)).split("\n").length;
    console.log(`  ${file}:${line}  ${rule.name}`);
    console.log(`      ${JSON.stringify(found.slice(0, 3))}`);
    console.log(`      ${rule.why}`);
  }
}

/*
 * The one field in the published dataset that is written *about the owner*.
 *
 * `opportunities.json` is exempted from the grade rule above, and rightly: an
 * organisation's own published minimum is the evidence the dataset rests on.
 * But the exemption is whole-file, and one field in that file is not a quote
 * from a page at all — `relevanceReason` is generated from the reader's own
 * profile, and while a model was writing it, it quoted his specialism, his
 * project and his certifications back into a public repository.
 *
 * It is deterministic now and says only what it needs to. This checks that,
 * field by field, so the exemption covers what it was meant to cover and no
 * more.
 */
console.log("");
{
  const PERSONAL = [
    { name: "a grade", re: /\bGPA\b|معدل\s*(?:تراكمي|المستخدم|الطالب)|\b[0-4]\.\d{1,2}\s*(?:من|\/)\s*[45]\b/ },
    { name: "a university", re: /جامعة\s+\S+|\bKFUPM\b|\bKAU\b/ },
    { name: "a certificate", re: /Security\+|CCNA|CEH|شهادة\s+(?:احترافية|مهنية)/i },
    { name: "a name or a mailbox", re: /[\w.+-]+@[\w.-]+\.\w{2,}|مشاري|السبيعي/i },
  ];
  let leaks = 0;
  try {
    const rows = JSON.parse(
      readFileSync("data/opportunities.json", "utf8").replace(/^﻿/, ""),
    ) as { relevanceReason?: string }[];
    for (const row of rows) {
      const reason = row.relevanceReason ?? "";
      for (const p of PERSONAL) {
        if (p.re.test(reason)) {
          leaks++;
          console.log(`  relevanceReason carries ${p.name}: ${reason.slice(0, 90)}`);
        }
      }
    }
    console.log(
      leaks === 0
        ? `  the ${rows.length} published reasons say nothing about the reader beyond his field`
        : `  ${leaks} published reason(s) say too much`,
    );
  } catch {
    console.log("  opportunities.json could not be read as JSON, so its reasons were not checked");
    leaks++;
  }
  hits += leaks;
}

console.log(
  hits === 0
    ? `\nprivacy: ${files.length} tracked files, nothing personal found`
    : `\nprivacy: ${hits} match(es). Do not push until these are gone from the working tree AND from history.`,
);
process.exit(hits === 0 ? 0 : 1);
