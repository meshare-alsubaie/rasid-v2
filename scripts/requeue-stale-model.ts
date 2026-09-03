/**
 * Un-score everything the discredited model judged.
 *
 * `llama3.1:8b` cannot write Arabic. Measured against the benchmark fixtures it
 * produced "الياعلان الثدرب الإعاني" and "الحداب الاشية الإليكي", and 0 of 3
 * replies survived a check that a claimed copy appears in the page it was
 * copied from. `qwen3:8b` gives 10 of 10. The default was changed, but the
 * records already in the file were judged by the old one and are still being
 * notified about — the notifier proposed "🟢 إعلان جديد · الأكاديمية الوطنية
 * للأمن السيبراني — البراغات الالميدية" after the switch.
 *
 * Some of those records look fine and some are gibberish, and there is no way
 * to tell which from the record alone: the page text is not stored. So none of
 * them is trusted. A score from a model that cannot write the language is not a
 * score, and keeping the plausible-looking ones would mean keeping exactly the
 * ones whose wrongness is hardest to see.
 *
 * Nothing is deleted. Every record keeps its title, its dates and its source;
 * it loses the number, gains `needs_manual_review`, and its page is put back in
 * the queue. The interface already has a state for that and says it plainly.
 *
 *   npx tsx scripts/requeue-stale-model.ts --dry-run
 *   npx tsx scripts/requeue-stale-model.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Opportunity, SourceSnapshot } from "../src/types";

const DRY = process.argv.includes("--dry-run");

/**
 * When the model changed. Anything confirmed before this was judged by llama.
 *
 * Passed as an argument rather than hardcoded so this is usable again the next
 * time a model is replaced, which is the point of it being a script.
 */
const before =
  process.argv.find((a) => a.startsWith("--before="))?.slice("--before=".length) ??
  "2026-09-02T22:00:00.000Z";

const read = <T>(p: string): T[] =>
  JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

const opportunities = read<Opportunity>("data/opportunities.json");
const snapshots = read<SourceSnapshot>("data/snapshots.json");

const stale = opportunities.filter(
  (o) => o.relevanceScore !== null && o.lastConfirmedISO < before,
);
console.log(
  `${stale.length} of ${opportunities.filter((o) => o.relevanceScore !== null).length} scored record(s) were judged before ${before}\n`,
);
for (const o of stale.slice(0, 10)) {
  console.log(`  ${String(o.relevanceScore).padStart(3)}  ${o.orgId.padEnd(12)}${o.titleAr.slice(0, 52)}`);
}
if (stale.length > 10) console.log(`  … and ${stale.length - 10} more`);

if (stale.length === 0) {
  console.log("\nnothing to requeue.");
  process.exit(0);
}

const staleUrls = new Set(stale.map((o) => o.sourceUrl));
for (const o of opportunities) {
  if (!staleUrls.has(o.sourceUrl)) continue;
  if (o.relevanceScore === null) continue;
  o.relevanceScore = null;
  o.relevanceReason =
    "لم يُحكم على هذه الصفحة بعد. الحكم السابق أنتجه نموذج ثبت أنه لا يكتب عربية سليمة، فأُلغي، والصفحة في الطابور لتُقرأ من جديد.";
  o.flags = [...new Set([...o.flags, "needs_manual_review" as const])];
}

/*
 * And the page goes back in the queue. Clearing the score without this would
 * leave a record that says "not judged" on a page nothing intends to re-read.
 */
let requeued = 0;
for (const s of snapshots) {
  if (!staleUrls.has(s.sourceUrl)) continue;
  if (s.pendingClassification) continue;
  s.pendingClassification = true;
  requeued++;
}

console.log(`\n${stale.length} record(s) un-scored, ${requeued} page(s) put back in the queue.`);

if (DRY) {
  console.log("dry run: nothing was written.");
  process.exit(0);
}

writeFileSync("data/opportunities.json", JSON.stringify(opportunities, null, 2) + "\n", "utf8");
writeFileSync("data/snapshots.json", JSON.stringify(snapshots, null, 2) + "\n", "utf8");
console.log("-> data/opportunities.json, data/snapshots.json");
process.exit(0);
