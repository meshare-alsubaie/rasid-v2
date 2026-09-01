/**
 * Does a .gov.sa site answer a data centre the way it answers a laptop?
 *
 * The whole rebuild hangs on this one fact. If Saudi government hosts serve a
 * rented server, collection moves off the student's laptop and runs around the
 * clock for nothing. If they refuse it, the laptop stays the only collector and
 * every later decision has to be built on that.
 *
 * So this file exists to be run from more than one place and compared. It has
 * no dependencies beyond Node 18 for exactly that reason: it has to run on a
 * bare cloud image with nothing installed but the runtime.
 *
 *   node vantage-probe.mjs --vantage=laptop-riyadh
 *   node vantage-probe.mjs --vantage=oracle-jeddah
 *
 * It copies the real collector's manners on purpose. Same User-Agent, same
 * accept headers, same 20s timeout, same robots.txt gate, same 1.5s per host.
 * A probe that is politer or ruder than the collector measures a client we do
 * not ship, and the answer would not transfer.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";

const HERE = dirname(fileURLToPath(import.meta.url));

/* Mirrors src/pipeline/agent.ts. Kept literal so this file stays standalone. */
const contact = process.env.RASID_CONTACT?.trim();
const USER_AGENT = contact
  ? `RASID-CoopTracker/1.0 (personal student project; contact: ${contact})`
  : "RASID-CoopTracker/1.0 (personal student project; set RASID_CONTACT for a contact address)";
const TIMEOUT_MS = 20_000;
const PER_HOST_GAP_MS = 1_500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Nothing personal leaves this file, because its output is meant to be
 * committed as the record of a decision.
 *
 * The contact address is a real personal email and the repository is public;
 * the egress address is a home connection. Neither adds anything to the
 * comparison the country code does not already give, and a benchmark file once
 * carried a quote from the student's own profile into a public commit. That
 * mistake is not worth repeating for a diagnostic.
 */
const maskContact = (ua) => ua.replace(/contact:\s*[^)]+/i, "contact: <set>");
const maskIp = (ip) => {
  if (!ip) return ip;
  if (ip.includes(":")) return ip.split(":").slice(0, 2).join(":") + ":…";
  const p = ip.split(".");
  return p.length === 4 ? `${p[0]}.${p[1]}.x.x` : ip;
};

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/* ------------------------------------------------------------------ robots */

/**
 * RFC 9309, the same asymmetry the collector uses: 4xx means no file and no
 * restriction, 5xx or an unreachable host means disallow for this run.
 *
 * And note what that asymmetry does for *this* probe. If a vantage cannot even
 * read robots.txt, that is not a neutral skip. It is the loudest possible
 * answer to the question being asked, so it is recorded as a result and never
 * as an absence.
 */
function parseRobots(text, ua) {
  const uaToken = ua.split("/")[0].toLowerCase();
  const groups = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === "allow" || field === "disallow")) {
      current.rules.push({ allow: field === "allow", path: value });
    } else if (current && field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  const specific = groups.find((g) => g.agents.some((a) => a === uaToken || uaToken.startsWith(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const group = specific ?? wildcard;
  if (!group) return { allowed: true, crawlDelayMs: PER_HOST_GAP_MS, matched: "no group" };

  const toRegex = (p) => {
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + (escaped.endsWith("$") ? escaped : escaped + ".*"));
  };

  return (path) => {
    let best = null;
    for (const rule of group.rules) {
      if (rule.path === "") continue; // "Disallow:" with nothing after it allows all
      if (!toRegex(rule.path).test(path)) continue;
      const len = rule.path.replace(/\*/g, "").length;
      // Longest match wins; Allow wins a tie, per RFC 9309.
      if (!best || len > best.len || (len === best.len && rule.allow)) best = { ...rule, len };
    }
    return {
      allowed: best ? best.allow : true,
      crawlDelayMs: Math.max(PER_HOST_GAP_MS, (group.crawlDelay ?? 0) * 1000),
      matched: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.path}` : "no matching rule",
    };
  };
}

async function robotsGate(origin, path) {
  const url = `${origin}/robots.txt`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "text/plain,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    const ms = Date.now() - started;

    if (res.status >= 400 && res.status < 500) {
      return { reachable: true, status: res.status, allowed: true, note: "no robots.txt (4xx)", ms };
    }
    if (res.status >= 500) {
      return { reachable: false, status: res.status, allowed: false, note: `robots.txt ${res.status}`, ms };
    }
    const decide = parseRobots(body, USER_AGENT);
    if (typeof decide !== "function") {
      return { reachable: true, status: res.status, allowed: true, note: decide.matched, ms };
    }
    const verdict = decide(path);
    return {
      reachable: true,
      status: res.status,
      allowed: verdict.allowed,
      crawlDelayMs: verdict.crawlDelayMs,
      note: verdict.matched,
      ms,
    };
  } catch (err) {
    return {
      reachable: false,
      status: null,
      allowed: false,
      note: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
      ms: Date.now() - started,
    };
  }
}

/* --------------------------------------------------------------- forensics */

/**
 * Who is standing in front of the origin, and did it stand in our way.
 *
 * The distinction matters more than the status code. A 403 from a plain nginx
 * is a path problem we can fix. A 403 from a bot manager is a vantage problem
 * we cannot, and it is the one that decides whether a rented server is usable.
 */
function fingerprint(headers, body) {
  const h = (n) => headers.get(n) ?? "";
  const server = h("server").toLowerCase();
  const edges = [];
  if (h("cf-ray") || server.includes("cloudflare")) edges.push("cloudflare");
  if (server.includes("akamai") || h("x-akamai-transformed") || h("x-akamai-request-id")) edges.push("akamai");
  if (h("x-iinfo") || h("x-cdn").toLowerCase().includes("incapsula")) edges.push("imperva");
  if (h("x-sucuri-id")) edges.push("sucuri");
  if (h("x-amz-cf-id") || server.includes("cloudfront")) edges.push("cloudfront");
  if (h("x-azure-ref")) edges.push("azure-front-door");
  if (server.includes("bigip") || h("x-waf-status")) edges.push("f5");
  if (h("x-fastly-request-id") || server.includes("varnish")) edges.push("fastly/varnish");

  const sample = (body ?? "").slice(0, 4000);
  const challenges = [];
  if (/just a moment|cf[-_]chl|cf-browser-verification|challenge-platform/i.test(sample)) challenges.push("cloudflare-challenge");
  if (/incapsula incident|request unsuccessful/i.test(sample)) challenges.push("imperva-block");
  if (/access denied.{0,200}reference\s*#/is.test(sample)) challenges.push("akamai-deny");
  if (/attention required|are you a robot|verify you are human/i.test(sample)) challenges.push("bot-interstitial");
  if (/\bcaptcha\b/i.test(sample)) challenges.push("captcha");

  return { server: h("server") || null, edges, challenges };
}

/* ------------------------------------------------------------------- probe */

async function probeOne(target) {
  const { origin, pathname, host } = new URL(target.url);
  const out = { ...target, ip: null, robots: null, http: null, verdict: null };

  try {
    const a = await lookup(host);
    out.ip = a.address;
  } catch (err) {
    out.ip = `DNS_FAIL: ${err instanceof Error ? err.message : String(err)}`;
  }

  out.robots = await robotsGate(origin, pathname);
  await sleep(PER_HOST_GAP_MS);

  if (!out.robots.allowed) {
    // Not a skip. The reason is the finding.
    out.verdict = out.robots.reachable ? "ROBOTS_DISALLOW" : "ROBOTS_UNREACHABLE";
    return out;
  }

  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ar,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    const ms = Date.now() - started;
    const fp = fingerprint(res.headers, body);
    const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body)?.[1]?.trim().replace(/\s+/g, " ") ?? null;

    out.http = {
      status: res.status,
      finalUrl: res.url,
      redirected: res.url !== target.url,
      bytes: Buffer.byteLength(body),
      contentType: res.headers.get("content-type"),
      title,
      ms,
      ...fp,
    };

    if (res.status >= 200 && res.status < 300 && fp.challenges.length === 0 && Buffer.byteLength(body) > 500) {
      out.verdict = "SERVED";
    } else if (fp.challenges.length > 0) {
      out.verdict = "CHALLENGED";
    } else if (res.status === 403 || res.status === 401 || res.status === 406 || res.status === 429) {
      out.verdict = "BLOCKED";
    } else if (res.status >= 400) {
      out.verdict = `HTTP_${res.status}`;
    } else {
      out.verdict = "THIN_BODY";
    }
  } catch (err) {
    out.http = { error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
    out.verdict = "NETWORK_FAIL";
  }
  return out;
}

/** Where this run is speaking from. Only our own egress address, nothing else. */
async function vantageIdentity() {
  try {
    const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(text)?.[1] ?? null;
    return { ip: maskIp(get("ip")), country: get("loc"), edge: get("colo") };
  } catch (err) {
    return { ip: null, country: null, edge: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const vantage = arg("vantage");
  if (!vantage) {
    console.error("usage: node vantage-probe.mjs --vantage=<label>   (e.g. laptop-riyadh, oracle-jeddah)");
    process.exit(2);
  }

  const targets = JSON.parse(readFileSync(join(HERE, "targets.json"), "utf8"));
  const identity = await vantageIdentity();

  console.log(`vantage : ${vantage}`);
  console.log(`egress  : ${identity.ip ?? "unknown"} (${identity.country ?? "?"}) via ${identity.edge ?? "?"}`);
  console.log(`agent   : ${maskContact(USER_AGENT)}`);
  console.log(`targets : ${targets.length}`);
  console.log("");

  const results = [];
  // Sequential on purpose: the collector never runs more than two at once, and
  // a burst is exactly the thing that would provoke a block we then misread.
  for (const t of targets) {
    const r = await probeOne(t);
    results.push(r);
    const detail =
      r.verdict === "SERVED"
        ? `${r.http.status} ${r.http.bytes}B ${r.http.ms}ms${r.http.edges.length ? " [" + r.http.edges.join(",") + "]" : ""}`
        : r.verdict.startsWith("ROBOTS")
          ? r.robots.note
          : (r.http?.error ?? `${r.http?.status ?? "-"} ${(r.http?.challenges ?? []).join(",")} ${(r.http?.edges ?? []).join(",")}`);
    console.log(`${r.verdict.padEnd(18)} ${r.host.padEnd(26)} ${detail}`);
  }

  const served = results.filter((r) => r.verdict === "SERVED").length;
  const report = {
    vantage,
    ranAtISO: new Date().toISOString(),
    egress: identity,
    userAgent: maskContact(USER_AGENT),
    summary: {
      total: results.length,
      served,
      blocked: results.filter((r) => r.verdict === "BLOCKED" || r.verdict === "CHALLENGED").length,
      robotsUnreachable: results.filter((r) => r.verdict === "ROBOTS_UNREACHABLE").length,
      other: results.filter((r) => !["SERVED", "BLOCKED", "CHALLENGED", "ROBOTS_UNREACHABLE"].includes(r.verdict)).length,
    },
    results,
  };

  mkdirSync(join(HERE, "results"), { recursive: true });
  const path = join(HERE, "results", `${vantage}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("");
  console.log(`SERVED ${served}/${results.length}  ->  ${path}`);
  // The verdict lives in the data, not in the exit code: a vantage that is
  // refused everywhere is a successful measurement, not a failed run.
  process.exit(0);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(1);
});
