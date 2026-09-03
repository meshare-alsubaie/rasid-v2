/**
 * Which organisations are being watched on somebody else's website.
 *
 * Taif Municipality was watched entirely on the national ministry's domain,
 * including a contact form about international partnerships — so an
 * announcement on the municipality's own site could never have been seen, and
 * the app reported it as monitored throughout. That is not a duplicate record
 * to merge away; it is a record pointing at the wrong place, and the two need
 * different fixes. Merging loses an organisation. Correcting loses nothing.
 *
 * This finds the rest of them. It proposes, and changes nothing.
 *
 *   npm run audit:domains
 */
import { readFileSync } from "node:fs";
import type { Organisation } from "../src/types";

/*
 * The dataset, or a fixture standing in for it.
 *
 * `test:gates` has to be able to plant an organisation on the wrong domain and
 * watch this catch it. Doing that by rewriting the real half-megabyte file for
 * a second, while a collection round may be holding it open, is how a gate
 * comes to corrupt the thing it guards. A path argument costs nothing and makes
 * the seeded fault harmless.
 */
const FILE = process.argv.slice(2).includes("--file")
  ? (process.argv[process.argv.indexOf("--file") + 1] ?? "data/organisations.json")
  : "data/organisations.json";

const orgs = JSON.parse(readFileSync(FILE, "utf8").replace(/^﻿/, "")) as Organisation[];

/** The registered domain: `careers.x.gov.sa` and `x.gov.sa` are one site. */
function registered(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".");
    // .gov.sa, .com.sa, .edu.sa all take three labels; everything else two.
    return parts.slice(-(parts.length > 2 && /^(gov|com|edu|org|net)$/.test(parts.at(-2) ?? "") ? 3 : 2)).join(".");
  } catch {
    return null;
  }
}

/** Who else is watched on this domain, and how heavily. */
const owners = new Map<string, Map<string, number>>();
for (const o of orgs) {
  for (const s of o.sources) {
    const d = registered(s.url);
    if (!d) continue;
    if (!owners.has(d)) owners.set(d, new Map());
    const m = owners.get(d)!;
    m.set(o.id, (m.get(o.id) ?? 0) + 1);
  }
}

interface Finding {
  org: Organisation;
  domain: string;
  onIt: number;
  total: number;
  alsoWatchedBy: string[];
}

/*
 * The cases where living on another organisation's domain is the truth.
 *
 * A unit inside a parent body genuinely publishes on the parent's site — the
 * National Centre for AI has no domain of its own, and `sdaia.gov.sa/ncai/` is
 * its page, not a record pointed at the wrong place. Left unnamed, that one
 * finding would either keep this audit advisory forever or make a gate that
 * fails on a correct dataset every run.
 *
 * Each entry is a claim about the world, so each carries why. Anything not
 * listed here fails, which is what makes this a gate rather than a report.
 */
const HOUSED_INSIDE: Record<string, { domain: string; why: string }> = {
  ncai: {
    domain: "sdaia.gov.sa",
    why: "المركز الوطني للذكاء الاصطناعي وحدة داخل سدايا، ولا نطاق مستقلّاً له",
  },
};

const findings: Finding[] = [];

for (const org of orgs) {
  const verified = org.sources.filter((s) => s.verifiedAtISO !== null);
  if (verified.length === 0) continue;

  const byDomain = new Map<string, number>();
  for (const s of verified) {
    const d = registered(s.url);
    if (d) byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  }

  for (const [domain, onIt] of byDomain) {
    /*
     * Whose domain is it? The id in the hostname settles it when it is there —
     * `zatca.gov.sa` belongs to `zatca`, whatever else is watched on it. That
     * matters because the answer decides who needs correcting: the first run of
     * this reported ZATCA as squatting on its own website, when the record in
     * the wrong place was the dissolved customs authority pointed at it.
     */
    const stem = domain.split(".")[0] ?? "";
    const claimants = [...(owners.get(domain) ?? new Map())].map(([id]) => id);
    const nativeOwner =
      claimants.find((id) => id === stem) ??
      claimants.find((id) => stem.includes(id) || id.includes(stem));

    if (nativeOwner === org.id) continue; // watched at home; nothing to fix
    if (HOUSED_INSIDE[org.id]?.domain === domain) continue; // published by its parent, on purpose

    const others = [...(owners.get(domain) ?? new Map())]
      .filter(([id, count]) => id !== org.id && (id === nativeOwner || count >= onIt))
      .map(([id]) => (id === nativeOwner ? `${id} (صاحب النطاق)` : id));

    // Somebody else is watched on this domain at least as heavily, and this
    // organisation has nothing of its own — the classic wrong-place record.
    if (others.length > 0 && onIt === verified.length) {
      findings.push({ org, domain, onIt, total: verified.length, alsoWatchedBy: others });
    }
  }
}

const housed = Object.entries(HOUSED_INSIDE);
if (housed.length > 0) {
  console.log(`${housed.length} organisation(s) are known to publish on a parent's domain:`);
  for (const [id, { domain, why }] of housed) console.log(`  ${id} على ${domain} — ${why}`);
  console.log("");
}

if (findings.length === 0) {
  console.log("no organisation is watched only on another organisation's domain.");
} else {
  console.log(
    `${findings.length} organisation(s) are watched only on a domain that belongs to someone else.\n` +
      "Nothing has been changed. The fix is a corrected source, never a merge.\n",
  );
  for (const f of findings.sort((a, b) => "SABC".indexOf(a.org.tier) - "SABC".indexOf(b.org.tier))) {
    console.log(`  ${f.org.id} (${f.org.tier}) — ${f.org.nameAr}`);
    console.log(`      كل مصادرها الـ${f.total} على ${f.domain}، وهو نطاق ${f.alsoWatchedBy.join("، ")}`);
    console.log(`      ${f.org.sources.filter((s) => s.verifiedAtISO !== null)[0]?.url ?? ""}`);
    console.log("");
  }
}

/*
 * This used to end here, printing and exiting zero whatever it found — so it
 * was a report somebody had to remember to run, and the Taif record it was
 * written for could have come back the next time a source was added without a
 * single check going red. It runs in `npm run gates` now and fails: a new
 * organisation watched only on another body's domain either gets its own
 * source, or gets named above with the reason.
 */
process.exit(findings.length === 0 ? 0 : 1);
