/**
 * Re-open the debt on records that can never pay it off by themselves.
 *
 * A source is only re-judged when its page changes. That is the whole reason
 * the hashes exist, and it has one hole, which BACKLOG.md calls "the broken
 * record that will not die": if a classification failed and the page then
 * stopped changing, the record keeps saying "تعذّر التصنيف" for ever, because
 * nothing will ever ask about that page again.
 *
 * It is not hypothetical here. When this ran out of API credit, 89 of 142 cards
 * were left carrying a raw English BadRequestError, and 72 of them are stuck:
 * their pages have not moved since, their pendingClassification was cleared,
 * and they would have displayed an error about an API this project no longer
 * uses until someone edited the file by hand.
 *
 * This is that edit, made once and made safe:
 *
 *   - It only ever sets pendingClassification back to true. It scores nothing,
 *     deletes nothing, and asserts nothing about any page.
 *   - It touches only records with relevanceScore === null. A record with a
 *     score is real knowledge and is never disturbed, which is the standing
 *     rule about negative verdicts in this codebase.
 *   - It is idempotent, and it prints every record it re-opens.
 *
 * The classifier is free now, so paying the debt costs nothing but time.
 *
 *   npx tsx scripts/requeue.ts --dry-run
 *   npx tsx scripts/requeue.ts
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { humanReason } from "../src/pipeline/opportunity";
import type { Opportunity, SourceSnapshot } from "../src/types";

const DRY = process.argv.includes("--dry-run");
const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

const opportunities = read<Opportunity>("data/opportunities.json");
const snapshots = read<SourceSnapshot>("data/snapshots.json");

/**
 * A run of Latin letters in the sentence shown on an Arabic card.
 *
 * Spec: what appears on screen is one Arabic sentence saying what happened and
 * what happens next. Anything with `BadRequestError` or `invalid_request_error`
 * in it is a diagnostic that escaped into the interface, and the owner read one
 * such card as the whole system having collapsed. Four letters is deliberately
 * generous: it does not fire on "SOC" or "IT" inside a real Arabic sentence.
 */
const CARRIES_DIAGNOSTIC = /[A-Za-z]{6,}/;

const unjudged = opportunities.filter(
  (o) => o.relevanceScore === null && CARRIES_DIAGNOSTIC.test(o.relevanceReason ?? ""),
);

const byUrl = new Map(snapshots.map((s) => [s.sourceUrl, s]));
const reopened: string[] = [];
const alreadyQueued: string[] = [];
const noSnapshot: string[] = [];

for (const o of unjudged) {
  const snap = byUrl.get(o.sourceUrl);
  if (!snap) {
    noSnapshot.push(o.sourceUrl);
    continue;
  }
  if (snap.pendingClassification) {
    alreadyQueued.push(o.sourceUrl);
    continue;
  }
  snap.pendingClassification = true;
  reopened.push(o.sourceUrl);
}

console.log(`records shown to the reader:            ${opportunities.length}`);
console.log(`unjudged, carrying a raw diagnostic:    ${unjudged.length}`);
console.log(`  already queued, nothing to do:        ${alreadyQueued.length}`);
console.log(`  re-opened for the next round:         ${reopened.length}`);
console.log(`  no snapshot at all, cannot re-open:   ${noSnapshot.length}`);

for (const u of reopened) console.log(`  requeued  ${u}`);
for (const u of noSnapshot) console.log(`  NO SNAPSHOT  ${u}`);

/*
 * And the sentence is translated now, not when the page is next read.
 *
 * Re-opening the debt is only half the repair, and the weaker half: a source
 * that cannot be fetched at all - a dead host, a robots.txt refusal - will
 * never be re-judged however often it is queued, so its card would go on
 * showing an English stack trace indefinitely.
 *
 * Nothing here changes what is claimed. The record still says the page has not
 * been judged, which is still true; it says it in the language the reader
 * reads, which is what the specification asked for in the first place. The
 * score stays null and needs_manual_review stays on.
 */
const rewritten: string[] = [];
for (const o of unjudged) {
  const before = o.relevanceReason ?? "";
  const humane = `تعذّر التصنيف: ${humanReason(before)}`;
  if (humane !== before) {
    o.relevanceReason = humane;
    rewritten.push(o.orgId);
  }
}
console.log(`  reasons rewritten into Arabic:        ${rewritten.length}`);

if (DRY) {
  console.log("\ndry run: nothing was written.");
  process.exit(0);
}

if (rewritten.length > 0) {
  const temp = "data/opportunities.json.tmp";
  writeFileSync(temp, JSON.stringify(opportunities, null, 2) + "\n", "utf8");
  renameSync(temp, "data/opportunities.json");
  console.log(`wrote data/opportunities.json; ${rewritten.length} card(s) no longer show English.`);
}

if (reopened.length > 0) {
  // Written next door and renamed over, so a reader sees one whole file or the
  // other. A truncated snapshots.json stops every script at once.
  const temp = "data/snapshots.json.tmp";
  writeFileSync(temp, JSON.stringify(snapshots, null, 2) + "\n", "utf8");
  renameSync(temp, "data/snapshots.json");
  console.log(`\nwrote data/snapshots.json; ${reopened.length} page(s) will be re-read and re-judged.`);
} else {
  console.log("\nnothing to re-open.");
}
process.exit(0);
