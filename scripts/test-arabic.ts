/**
 * The interface speaks Arabic, and says so under the live data.
 *
 * This is a gate rather than a review because the leaks were never in the
 * strings anyone wrote: they came through seams. A sector name arrived from the
 * dataset as `semi_gov` and went straight into a dropdown the reader is meant to
 * choose from. An error arrived from a library and went into the health panel
 * with the owner's hard drive still in it. An organisation id went into the
 * banner at the top of the screen, seven times over, because the health rows are
 * per source and nobody deduplicated them.
 *
 * So the checks here run the *real dataset* through the *real functions*. A new
 * organisation with an unlisted sector, or a new failure mode with a new English
 * message, fails this the day it appears rather than the day someone notices.
 *
 *   npm run test:arabic
 */
import { readFileSync } from "node:fs";
import { counted, humanError, KNOWN_SECTORS, sectorLabel } from "../src/app/messages";
import type { Organisation, SourceHealth } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

const read = <T>(p: string): T[] =>
  JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

/**
 * A word, not an acronym or a code: four Latin letters in a row.
 *
 * Text the page itself wrote, quoted, does not count. When a source returns a
 * page titled "Error", saying so requires printing that word, and the quotation
 * marks are what tell the reader it is the site's word and not ours. Quoting
 * foreign text is the honest thing; leaving our own sentence in English is not.
 */
const hasEnglishWord = (s: string): boolean =>
  /[A-Za-z]{4,}/.test(s.replace(/«[^»]*»|"[^"]*"|'[^']*'/g, ""));

console.log("every error the dataset holds becomes an Arabic sentence");
{
  const health = read<SourceHealth>("data/health.json");
  const errors = [...new Set(health.map((h) => h.lastError).filter((e): e is string => e !== null))];
  check("there are errors to translate", errors.length > 0, `${errors.length} distinct`);

  const untranslated = errors.filter((e) => hasEnglishWord(humanError(e)));
  check(
    "none of them still reads as English",
    untranslated.length === 0,
    untranslated.slice(0, 3).map((e) => `${e.slice(0, 40)} -> ${humanError(e)}`).join(" ;; "),
  );

  const empty = errors.filter((e) => humanError(e).trim() === "");
  check("and none of them becomes nothing at all", empty.length === 0);

  /*
   * The seeded fault: the raw strings themselves. If these ever stop looking
   * English, the corpus has changed and this gate is no longer testing anything.
   */
  check(
    "the raw errors really are English (seeded fault)",
    errors.some((e) => hasEnglishWord(e)),
    "otherwise the check above passes for the wrong reason",
  );
}

console.log("\nevery sector in the dataset has a label");
{
  const orgs = read<Organisation>("data/organisations.json");
  const sectors = [...new Set(orgs.map((o) => o.sector))];
  check("there are sectors to label", sectors.length > 0, sectors.join(", "));

  const unlabelled = sectors.filter((s) => !KNOWN_SECTORS.includes(s));
  check(
    "no sector falls through to its code name",
    unlabelled.length === 0,
    unlabelled.join(", "),
  );
  const stillEnglish = sectors.filter((s) => hasEnglishWord(sectorLabel(s)));
  check("and no label is English", stillEnglish.length === 0, stillEnglish.join(", "));
}

console.log("\nthe screens carry no leftover code vocabulary");
{
  const main = readFileSync("src/app/main.ts", "utf8");

  check(
    "the top banner names organisations, not their ids",
    /banner[\s\S]{0,200}orgById\.get\(h\.orgId\)\?\.nameAr/.test(main),
    "it printed `sdaia، albilad، maaden، maaden…` — Latin, and repeated once per source",
  );
  check(
    "and it does not repeat one organisation once per source",
    /banner[\s\S]{0,200}new Set\(/.test(main),
  );
  check(
    "the health panel translates before it prints",
    /humanError\(h\.lastError\)/.test(main),
  );
  check(
    "the sector filter shows a label, not the stored value",
    /sectorLabel\(s\)/.test(main),
  );
}

/*
 * Two rules the owner set for every Arabic string this project writes. They are
 * checked mechanically because both are invisible when you are reading quickly,
 * and both were being broken in text on the screen.
 */
console.log("\nthe two Arabic writing rules hold in what is displayed");
{
  const sources = ["src/app/main.ts", "src/app/messages.ts", "src/app/season-bar.ts", "index.html"];
  for (const file of sources) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    /*
     * Only strings the reader sees: Arabic runs. A comment in English is fine.
     *
     * The quantifier was lazy, and a lazy run stops at the *first* Arabic
     * character it can — so it matched the two letters either side of a comma
     * and never reached the em dash three words along. Three of them sat in the
     * organisation sheet and on the notification screen while this printed
     * "pass" four times: a gate that was looking at the wrong two characters.
     *
     * Greedy, it spans the whole line between the first Arabic character and
     * the last, which is exactly the span a reader sees.
     */
    const arabicRuns = text.match(/[؀-ۿ][^\n]*[؀-ۿ]/g) ?? [];
    const dashed = arabicRuns.filter((r) => r.includes("—"));
    check(`${file}: no em dash in displayed Arabic`, dashed.length === 0, dashed.slice(0, 2).join(" | "));
  }
}

console.log("\nthe interface counts in Arabic, not in spreadsheet");
{
  /*
   * "١ نافذة مفتوحة" is not a sentence anybody writes. Arabic counts one and
   * two inside the noun and returns to the singular at eleven, and the headline
   * on the first screen ignored all of it — a small thing that tells a reader
   * the text was assembled rather than written, on a screen whose whole claim
   * is that it says true things carefully.
   */
  const W: [string, string, string] = ["نافذة", "نافذتان", "نوافذ"];
  const cases: [number, string][] = [
    [1, "نافذة واحدة"],
    [2, "نافذتان"],
    [3, "3 نوافذ"],
    [10, "10 نوافذ"],
    [11, "11 نافذة"],
    [25, "25 نافذة"],
  ];
  for (const [n, want] of cases) {
    check(`${n} reads as "${want}"`, counted(n, W) === want, counted(n, W));
  }
  check("and no count ever starts with a bare 1", !/^1 /.test(counted(1, W)));
}

console.log(`\n${failures === 0 ? "the interface is Arabic all the way down" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
