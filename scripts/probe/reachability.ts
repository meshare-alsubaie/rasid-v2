/**
 * Can this machine actually reach every source, right now?
 *
 * Not "did the last round record a success" - that answers a question about
 * the past and about our own code. This opens every verified source from this
 * address, today, with the collector's own manners, and reports what each host
 * really does. It is the only way to tell a page we cannot read from a page
 * that no longer exists, and the difference decides whether a source should be
 * fixed, replaced, or dropped.
 *
 * Read-only: it writes a report and touches nothing the pipeline uses.
 *
 *   npx tsx scripts/probe/reachability.ts
 *   npx tsx scripts/probe/reachability.ts --tier=S,A
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../../src/pipeline/env";
import { PER_HOST_GAP_MS } from "../../src/pipeline/agent";
import { fetchPage } from "../../src/pipeline/fetch";
import { extract, isSoft404 } from "../../src/pipeline/extract";
import { checkRobots } from "../../src/pipeline/robots";
import type { Organisation, SourceHealth } from "../../src/types";

loadEnvFile();

const arg = (n: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const tierFilter = arg("tier")?.split(",").map((t) => t.trim().toUpperCase()) ?? null;

const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];
const orgs = read<Organisation>("data/organisations.json");
const health = new Map(read<SourceHealth>("data/health.json").map((h) => [h.sourceUrl, h]));

interface Row {
  orgId: string;
  orgAr: string;
  tier: string;
  url: string;
  type: string;
  /** What the collector believes, from the last round. */
  recordedState: string;
  /** What actually happened just now. */
  verdict: string;
  detail: string;
  chars: number | null;
  ms: number;
}

const targets = orgs
  .filter((o) => tierFilter === null || tierFilter.includes(o.tier))
  .flatMap((o) =>
    o.sources
      .filter((s) => s.verifiedAtISO !== null)
      .map((s) => ({ org: o, url: s.url, type: s.type })),
  );

console.log(`opening ${targets.length} verified source(s) from this machine\n`);

const rows: Row[] = [];
let done = 0;

for (const t of targets) {
  const started = Date.now();
  const recorded = health.get(t.url)?.state ?? "no record";
  const push = (verdict: string, detail: string, chars: number | null): void => {
    rows.push({
      orgId: t.org.id,
      orgAr: t.org.nameAr,
      tier: t.org.tier,
      url: t.url,
      type: t.type,
      recordedState: recorded,
      verdict,
      detail,
      chars,
      ms: Date.now() - started,
    });
  };

  const robots = await checkRobots(t.url);
  if (!robots.allowed) {
    push("ROBOTS_BLOCKED", robots.reason ?? "", null);
  } else {
    const res = await fetchPage(t.url, robots.crawlDelayMs || PER_HOST_GAP_MS);
    if (!res.ok) {
      push("UNREACHABLE", res.error, null);
    } else {
      const ex = extract(res.html, t.url);
      if (isSoft404(ex.title)) push("SOFT_404", `title: ${ex.title}`, ex.chars);
      else if (ex.chars < 50) push("EMPTY", `${res.bytes} bytes in, ${ex.chars} chars out`, ex.chars);
      else if (ex.chars < 400) push("THIN", `only ${ex.chars} chars of text`, ex.chars);
      else push("READ", ex.title ?? "", ex.chars);
    }
  }

  done++;
  if (done % 25 === 0) console.log(`  ${done}/${targets.length}`);
}

const counts = rows.reduce<Record<string, number>>((a, r) => {
  a[r.verdict] = (a[r.verdict] ?? 0) + 1;
  return a;
}, {});

console.log("\nwhat this machine can actually read, today");
for (const [v, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.padEnd(16)} ${String(n).padStart(4)}`);
}

/*
 * The comparison that matters: where the stored health record and reality
 * disagree. A source recorded healthy that cannot be read is a false green
 * light, and a source recorded broken that reads fine is a hole in the
 * coverage nobody is looking at.
 */
const falseGreen = rows.filter((r) => r.recordedState === "healthy" && r.verdict !== "READ");
const falseRed = rows.filter((r) => r.recordedState === "broken" && r.verdict === "READ");
console.log(`\nrecorded healthy but unreadable now : ${falseGreen.length}`);
for (const r of falseGreen.slice(0, 30)) console.log(`  ${r.tier} ${r.orgId.padEnd(16)} ${r.verdict.padEnd(15)} ${r.url}`);
console.log(`\nrecorded broken but reads fine now  : ${falseRed.length}`);
for (const r of falseRed.slice(0, 30)) console.log(`  ${r.tier} ${r.orgId.padEnd(16)} ${r.chars} chars  ${r.url}`);

/* Organisations with nothing readable at all: the real coverage hole. */
const byOrg = new Map<string, Row[]>();
for (const r of rows) byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r]);
const blind = [...byOrg.entries()].filter(([, rs]) => rs.every((r) => r.verdict !== "READ"));
console.log(`\norganisations with NO readable source at all: ${blind.length}`);
for (const [id, rs] of blind) {
  console.log(`  ${rs[0]!.tier} ${id.padEnd(18)} ${rs[0]!.orgAr}`);
  for (const r of rs) console.log(`       ${r.verdict.padEnd(15)} ${r.detail.slice(0, 60)}  ${r.url}`);
}

mkdirSync("scripts/probe/results", { recursive: true });
writeFileSync(
  "scripts/probe/results/reachability.json",
  JSON.stringify({ ranAtISO: new Date().toISOString(), counts, rows }, null, 2) + "\n",
  "utf8",
);
console.log("\n-> scripts/probe/results/reachability.json");
process.exit(0);
