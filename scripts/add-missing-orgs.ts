/**
 * The employers the audit found running co-op that were not in the file at all.
 *
 * The dataset covers 115 organisations and was assembled from a 2021 directory
 * and the specification. A legitimacy audit went looking for what it *missed*,
 * which is the one gap no amount of checking the existing rows can find, and the
 * answer included the single most relevant employer in the country for this
 * particular student: **sirar by stc**, whose careers page advertises a
 * cybersecurity co-op in those words.
 *
 * Every entry here was cited by that audit with a public page. None of them is
 * opened by this script: `provenance` is `reported` and `verifiedAtISO` is null,
 * so the collector will not fetch them and the validator will not let them claim
 * otherwise. `npm run verify-leads` is the step that opens a page and decides.
 *
 * Nothing existing is touched. Organisations are added, never merged.
 *
 *   npx tsx scripts/add-missing-orgs.ts --dry-run
 *   npx tsx scripts/add-missing-orgs.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Organisation } from "../src/types";

const DRY = process.argv.includes("--dry-run");

interface Seed {
  id: string;
  nameAr: string;
  nameEn: string;
  sector: Organisation["sector"];
  tier: Organisation["tier"];
  /** Why this one is here, in the audit's words. */
  why: string;
  sources: { url: string; type: string }[];
}

const SEEDS: Seed[] = [
  {
    id: "sirar",
    nameAr: "سرار من stc",
    nameEn: "sirar by stc",
    sector: "tech",
    // S, and not out of enthusiasm: it is a cybersecurity company advertising a
    // cybersecurity co-op, for a cybersecurity student. Nothing in the existing
    // dataset matches this reader more precisely.
    tier: "S",
    why: "تعاون أمن سيبراني منصوص عليه في صفحة التوظيف",
    sources: [
      { url: "https://www.sirar.com.sa/about-us/careers/", type: "careers_page" },
      { url: "https://www.sirar.com.sa/", type: "site_root" },
    ],
  },
  {
    id: "tahakom",
    nameAr: "تحاكم",
    nameEn: "Tahakom",
    sector: "semi_gov",
    tier: "S",
    why: "تعاوني يستهدف الأمن السيبراني وعلوم الحاسب والذكاء الاصطناعي",
    sources: [
      { url: "https://www.tahakom.com/careers", type: "careers_page" },
      { url: "https://www.tahakom.com/", type: "site_root" },
    ],
  },
  {
    id: "kacst",
    nameAr: "مدينة الملك عبدالعزيز للعلوم والتقنية",
    nameEn: "KACST",
    sector: "gov",
    tier: "A",
    why: "بوابة تدريب تعاوني مخصّصة، لطلاب السنة الأخيرة في العلوم التطبيقية",
    sources: [
      { url: "https://coop.kacst.edu.sa/", type: "portal" },
      { url: "https://www.kacst.edu.sa/", type: "site_root" },
    ],
  },
  {
    id: "nic_moi",
    nameAr: "المركز الوطني للمعلومات",
    nameEn: "National Information Center",
    sector: "gov",
    tier: "A",
    why: "تعاوني يشمل تقنية المعلومات ونظم المعلومات الإدارية",
    sources: [
      { url: "https://www.moi.gov.sa/wps/portal/Home/sectors/nic/", type: "site_root" },
    ],
  },
  {
    id: "sami",
    nameAr: "الشركة السعودية للصناعات العسكرية",
    nameEn: "SAMI",
    sector: "semi_gov",
    tier: "A",
    why: "تعاوني، وبرنامج روّاد الصناعة، وشراكة مع مسك",
    sources: [
      { url: "https://www.sami.com.sa/careers/", type: "careers_page" },
      { url: "https://www.sami.com.sa/", type: "site_root" },
    ],
  },
  {
    id: "zain_ksa",
    nameAr: "زين السعودية",
    nameEn: "Zain KSA",
    sector: "tech",
    tier: "B",
    why: "تدريب تعاوني وصيفي يشمل تقنية المعلومات وعلوم الحاسب",
    sources: [
      { url: "https://sa.zain.com/ar/careers/join-zain", type: "careers_page" },
    ],
  },
  {
    id: "sec",
    nameAr: "الشركة السعودية للكهرباء",
    nameEn: "Saudi Electricity Company",
    sector: "semi_gov",
    tier: "B",
    why: "تعاوني في أربع مناطق، تقني وإداري",
    sources: [{ url: "https://se.com.sa/nh", type: "careers_page" }],
  },
  {
    id: "sab",
    nameAr: "البنك السعودي الأول",
    nameEn: "Saudi Awwal Bank",
    sector: "bank",
    tier: "B",
    why: "برنامج تدريب تعاوني معلَن",
    sources: [{ url: "https://careers.sab.com/ar/", type: "careers_page" }],
  },
  {
    id: "spl",
    nameAr: "البريد السعودي",
    nameEn: "Saudi Post (SPL)",
    sector: "semi_gov",
    tier: "C",
    why: "برنامج «إتمام» للتدريب التعاوني، لجميع التخصصات",
    sources: [{ url: "https://splonline.com.sa/ar/careers/", type: "careers_page" }],
  },
  {
    id: "ncvc",
    nameAr: "المركز الوطني لتنمية الغطاء النباتي",
    nameEn: "NCVC",
    sector: "gov",
    tier: "C",
    why: "صفحة تدريب تعاوني معلَنة",
    sources: [{ url: "https://ncvc.gov.sa/en/Pages/COOP-Training.aspx", type: "careers_page" }],
  },
  {
    id: "flyadeal",
    nameAr: "طيران أديل",
    nameEn: "flyadeal",
    sector: "semi_gov",
    tier: "C",
    why: "إعلان تعاوني ٢٠٢٦ منشور على بوابة التوظيف",
    sources: [{ url: "https://careers.flyadeal.com/", type: "careers_page" }],
  },
  {
    id: "kafd",
    nameAr: "مركز الملك عبدالله المالي",
    nameEn: "KAFD",
    sector: "semi_gov",
    tier: "C",
    why: "شواغر تعاوني مفتوحة على بوابة التوظيف",
    sources: [{ url: "https://careers.kafd.sa/", type: "careers_page" }],
  },
];

const path = "data/organisations.json";
const orgs = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Organisation[];
const existing = new Set(orgs.map((o) => o.id));

let added = 0;
for (const s of SEEDS) {
  if (existing.has(s.id)) {
    console.log(`  = ${s.id}: already present, left alone`);
    continue;
  }
  orgs.push({
    id: s.id,
    nameAr: s.nameAr,
    nameEn: s.nameEn,
    sector: s.sector,
    city: [],
    tier: s.tier,
    /*
     * Every judgement field starts unknown, and that is the point. Nothing here
     * has been read yet, so claiming that an organisation accepts this major, or
     * pays a stipend, would be inventing exactly the kind of fact the validator
     * exists to refuse. The interface says "not known" and means it.
     */
    requiresZeroCourses: { value: null, provenance: "unknown" },
    acceptsUserMajor: null,
    offersCoopProduct: true,
    stipend: { amountSAR: null, provenance: "unknown" },
    flexibility: "unknown",
    intakeSize: "unknown",
    trainingQuality: null,
    sources: s.sources.map((src) => ({
      url: src.url,
      provenance: "reported" as const,
      verifiedAtISO: null,
      verifiedNote: `أُضيف من تدقيق شرعيّة المصادر: ${s.why}`,
      type: src.type as Organisation["sources"][number]["type"],
      checkFrequencyHours: 12,
      renderMode: "static" as const,
      coopConfirmed: false,
    })),
    applyVia: null,
    manualCheckUrl: null,
    historicalWindows: [],
    importSource: "manual",
  } as Organisation);
  added++;
  console.log(`  + ${s.tier} ${s.id.padEnd(10)} ${s.nameAr}  (${s.why})`);
}

console.log(
  `\n${added} organisation(s) added, now ${orgs.length}.` +
    ` Their sources are unverified; run "npm run verify-leads" to open them.`,
);

if (DRY) {
  console.log("dry run: nothing was written.");
  process.exit(0);
}

writeFileSync(path, JSON.stringify(orgs, null, 2) + "\n", "utf8");
console.log(`-> ${path}`);
process.exit(0);
