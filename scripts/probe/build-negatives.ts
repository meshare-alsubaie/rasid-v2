/**
 * Ordinary pages, fetched and extracted exactly the way the collector does.
 *
 * The twenty benchmark cases are all real announcements, so on their own they
 * measure only half of a triage model: a model that answers "yes" to
 * everything scores twenty out of twenty. These are the other half, and they
 * are deliberately not invented. They are ministry front pages and news
 * sections from the same `.gov.sa` hosts the collector reads every day, put
 * through the same extractor, so the text the model sees here is the text it
 * will see in production.
 *
 *   npx tsx scripts/probe/build-negatives.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PER_HOST_GAP_MS } from "../../src/pipeline/agent.js";
import { fetchPage } from "../../src/pipeline/fetch.js";
import { extract } from "../../src/pipeline/extract.js";
import { checkRobots } from "../../src/pipeline/robots.js";

/* Front pages and news sections: real, public, and not announcements. */
const PAGES: { id: string; url: string }[] = [
  { id: "neg_moh_home", url: "https://www.moh.gov.sa/Pages/Default.aspx" },
  { id: "neg_zatca_home", url: "https://zatca.gov.sa/ar" },
  { id: "neg_sfda_home", url: "https://www.sfda.gov.sa/ar" },
  { id: "neg_stats_home", url: "https://www.stats.gov.sa/ar" },
  { id: "neg_mof_home", url: "https://www.mof.gov.sa/Pages/default.aspx" },
  { id: "neg_moe_home", url: "https://www.moe.gov.sa/ar/Pages/default.aspx" },
  { id: "neg_nca_home", url: "https://nca.gov.sa/ar/" },
  { id: "neg_mewa_home", url: "https://www.mewa.gov.sa/ar/Pages/default.aspx" },
];

async function main(): Promise<void> {
  const out: { id: string; url: string; title: string | null; chars: number; text: string }[] = [];

  for (const p of PAGES) {
    const robots = await checkRobots(p.url);
    if (!robots.allowed) {
      console.log(`skip  ${p.id}  robots: ${robots.reason}`);
      continue;
    }
    const res = await fetchPage(p.url, robots.crawlDelayMs);
    if (!res.ok) {
      console.log(`skip  ${p.id}  ${res.error}`);
      continue;
    }
    const ex = extract(res.html, p.url);
    if (ex.chars < 400) {
      console.log(`skip  ${p.id}  only ${ex.chars} chars extracted`);
      continue;
    }
    out.push({ id: p.id, url: p.url, title: ex.title, chars: ex.chars, text: ex.text.slice(0, 6000) });
    console.log(`ok    ${p.id}  ${ex.chars} chars  ${ex.method}  ${ex.title ?? ""}`);
  }

  const dir = join(process.cwd(), "scripts", "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "negatives.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\nwrote ${out.length} ordinary pages -> scripts/probe/negatives.json`);
  if (out.length < 5) {
    console.error("too few ordinary pages to measure specificity against");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("build-negatives crashed:", err);
  process.exit(1);
});
