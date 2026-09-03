/**
 * The corrections the source-legitimacy audit found, applied once.
 *
 * The audit's finding was not that the domains are wrong. It is that 65% of the
 * watched pages are pages an announcement cannot appear on — homepages, media
 * centres, news permalinks — and that for a dozen organisations the real
 * co-op page exists, is public, and is simply not in the file. One of them,
 * `sidf.gov.sa/Coop`, was open with a live application link while the app was
 * watching that organisation's homepage and its press releases.
 *
 * Everything added here is marked unverified, because this script has not
 * opened any of them. `verify-leads` opens a lead, reads it, and decides; that
 * is the step that is allowed to say a page is real, and it is deliberately not
 * this one. Nothing is merged and no organisation is created: only sources are
 * added, and the six removals are pages that belong to a *different* body than
 * the one they are filed under.
 *
 *   npx tsx scripts/fix-sources.ts --dry-run
 *   npx tsx scripts/fix-sources.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Organisation } from "../src/types";

const DRY = process.argv.includes("--dry-run");

/** New sources, by organisation id. Every one came from the audit with a citation. */
const ADD: Record<string, { url: string; type: string; why: string }[]> = {
  ncac: [
    {
      url: "https://haseen.gov.sa/academy/ar/",
      type: "careers_page",
      why: "الأكاديمية انتقلت إلى هنا، و`ncac.edu.sa` يرفض الاتّصال",
    },
    {
      url: "https://nca.gov.sa/ar/nca-academy/",
      type: "announcement_page",
      why: "صفحة الأكاديمية على نطاق الهيئة، وتشير إلى الموقع الجديد",
    },
  ],
  nca: [
    {
      url: "https://nca.gov.sa/ar/cyber-training-and-qualifications/cybersecurity-program-3/",
      type: "announcement_page",
      why: "برامج التدريب والتأهيل السيبراني، وهي الصفحة التي تُنشر عليها الدفعات",
    },
  ],
  sidf: [
    {
      url: "https://www.sidf.gov.sa/Coop",
      type: "careers_page",
      why: "صفحة التدريب التعاوني، وكانت مفتوحة برابط تقديم حيّ وقت التدقيق",
    },
  ],
  sabic: [
    { url: "https://jobs.sabic.com/", type: "careers_page", why: "بوابة التوظيف التي تحيل إليها صفحة الطلاب" },
  ],
  pif: [
    { url: "https://careers.pif.gov.sa/", type: "careers_page", why: "بوابة التوظيف، والمراقَب كان الصفحة الرئيسية وحدها" },
  ],
  citc: [
    { url: "https://new.cst.gov.sa/ar/business/about/career", type: "careers_page", why: "صفحة التوظيف على النطاق الجديد" },
  ],
  tadawul: [
    {
      url: "https://www.tadawulgroup.sa/wps/portal/tadawulgroup/joinus",
      type: "careers_page",
      why: "بوابة المجموعة، والمراقَب كان الشركة التابعة وصفحتها تردّ ٤٠٣",
    },
  ],
  swcc: [{ url: "https://www.swcc.gov.sa/ar/Career", type: "careers_page", why: "صفحة التوظيف" }],
  mawhiba: [
    {
      url: "https://former.mawhiba.org/Ar/e-services/Pages/Internship.aspx",
      type: "careers_page",
      why: "صفحة التدريب على النطاق القديم، وهي الوحيدة القائمة",
    },
  ],
  ncai: [
    {
      url: "https://sdaia.gov.sa/ar/Sectors/Ncai/Pages/default.aspx",
      type: "announcement_page",
      why: "صفحة المركز داخل سدايا، والمسار القديم لم يعد يردّ",
    },
  ],
  redf: [
    { url: "https://www.redf.gov.sa/ar/careers", type: "careers_page", why: "صفحة التوظيف على نطاق الصندوق نفسه" },
  ],
  ssc: [
    { url: "https://www.ssa.gov.sa/ar/careers", type: "careers_page", why: "صفحة التوظيف، والمراقَب كان لافتة تحقّق فقط" },
  ],
};

/**
 * Sources filed under the wrong organisation entirely.
 *
 * Not "stale" and not "broken": these are another body's pages. `redf` was
 * being watched on a Ministry of Housing link, so a Ministry of Housing notice
 * would have been reported as the Real Estate Development Fund's.
 */
const REMOVE: Record<string, string[]> = {
  redf: ["https://www.housing.gov.sa/ar/related-links/140"],
};

const path = "data/organisations.json";
const orgs = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Organisation[];
const byId = new Map(orgs.map((o) => [o.id, o]));

let added = 0;
let removed = 0;
let skipped = 0;

for (const [id, sources] of Object.entries(ADD)) {
  const org = byId.get(id);
  if (org === undefined) {
    console.log(`  ? ${id}: no such organisation, skipped`);
    continue;
  }
  for (const s of sources) {
    if (org.sources.some((existing) => existing.url === s.url)) {
      skipped++;
      continue;
    }
    org.sources.push({
      url: s.url,
      // Not "official": that word means we opened it and saw it, and the
      // validator enforces exactly that. It is a reported lead until
      // verify-leads reads it.
      provenance: "reported",
      // Not opened by this script. `verify-leads` is what is allowed to say a
      // page is real, and until it does, the collector will not fetch this.
      verifiedAtISO: null,
      verifiedNote: `أُضيف من تدقيق شرعيّة المصادر: ${s.why}`,
      type: s.type as Organisation["sources"][number]["type"],
      checkFrequencyHours: 12,
      renderMode: "static",
      coopConfirmed: false,
    });
    added++;
    console.log(`  + ${id.padEnd(10)} ${s.url}`);
  }
}

for (const [id, urls] of Object.entries(REMOVE)) {
  const org = byId.get(id);
  if (org === undefined) continue;
  for (const url of urls) {
    const before = org.sources.length;
    org.sources = org.sources.filter((s) => s.url !== url);
    if (org.sources.length < before) {
      removed++;
      console.log(`  - ${id.padEnd(10)} ${url}  (belongs to another organisation)`);
    }
  }
}

console.log(
  `\n${added} source(s) added, ${removed} removed, ${skipped} already present.` +
    ` Added sources are unverified; run "npm run verify-leads" to open them.`,
);

if (DRY) {
  console.log("dry run: nothing was written.");
  process.exit(0);
}

writeFileSync(path, JSON.stringify(orgs, null, 2) + "\n", "utf8");
console.log(`-> ${path}`);
process.exit(0);
