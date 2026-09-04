/**
 * When two urls are the same page, for the purpose of not fetching it twice.
 *
 * Both places that dedupe sources stripped the whole fragment, on the reasoning
 * that `#section` does not make a different page. That is right about an anchor
 * and wrong about a route. A hash-routed application — and Saudi portals run
 * plenty of them — puts the entire path after the `#`:
 *
 *     https://x.gov.sa/#/careers/coop
 *     https://x.gov.sa/#/careers/graduate
 *
 * Stripped, those are one url. One of them is then dropped as a duplicate, and
 * the announcement on the dropped one is never read: the collector reports the
 * organisation as watched, the page is live, and nothing connects the two. It
 * is the quietest way this project can fail.
 *
 * So an anchor is still discarded and a route is kept. The test is the shape of
 * the fragment, which is the only evidence available without fetching: a route
 * carries a path separator or the `!` of the older convention; an anchor is a
 * bare identifier. A fragment we cannot classify is kept, because keeping one
 * costs a second fetch and dropping one costs a semester.
 */
import type { SourceType } from "../types";

const ANCHOR = /^[A-Za-z0-9_:.-]*$/;

export function addressOf(url: string): string {
  const hash = url.indexOf("#");
  const base = (hash === -1 ? url : url.slice(0, hash)).replace(/\/+$/, "").toLowerCase();
  if (hash === -1) return base;

  const fragment = url.slice(hash + 1);
  if (fragment === "" || ANCHOR.test(fragment)) return base;
  return `${base}#${fragment.replace(/\/+$/, "").toLowerCase()}`;
}

/**
 * The type a url has actually earned.
 *
 * Lives here rather than in `verify-leads.ts` because a gate has to be able to
 * call it, and importing that script runs a whole verification pass as a side
 * effect. The rule decides two things at once: what the interface tells the
 * reader a page is, and — through `alwaysJudge` in `collect.ts` — whether the
 * page skips the cost filter and is sent to the model on every round.
 */
const HOME_SEGMENTS = new Set([
  "ar",
  "en",
  "ar-sa",
  "en-sa",
  "ar-us",
  "en-us",
  "web",
  "pages",
  "home",
  "index.php",
  "index.html",
  "index.htm",
  "default.aspx",
  "default.html",
  "home.aspx",
]);

/** A homepage is still a homepage when it is reached through /ar/Pages/default.aspx. */
export function isHomePath(u: URL): boolean {
  return u.pathname
    .split("/")
    .filter(Boolean)
    .every((part) => HOME_SEGMENTS.has(part.toLowerCase()) || /^\d+$/.test(part));
}

/**
 * A path that dates itself is an archived article, whatever words it contains.
 *
 * `typeFor` matched "career" anywhere in the address, so
 * `/en/About-the-Bank/News/2013/05/alinmajobandcareerdayattracts…` — a press
 * release from May 2013 about a careers day — was recorded as a `careers_page`.
 * Twenty sources were in that state, from 2009 through 2014.
 *
 * That is not only a wrong label. `collect.ts` builds `alwaysJudge` from
 * `type === "careers_page"`, so each of those twenty bypassed the cost filter
 * and was sent to the model on every single round, for ever, to be told again
 * that a thirteen-year-old press release is not an announcement. The filter
 * written to stop exactly that waste was disarmed by a label it could not see.
 *
 * A year between 1990 and the year after this one, as its own path segment, is
 * the signature. `/2013/05/` matches; `/careers/vision-2030-programme` does
 * not, because 2030 is neither a plausible publication year nor a bare segment.
 */
export function isDatedArticle(u: URL): boolean {
  const thisYear = new Date().getFullYear();
  return u.pathname
    .split("/")
    .filter(Boolean)
    .some(
      (part) =>
        /^(?:19|20)\d\d$/.test(part) && Number(part) >= 1990 && Number(part) <= thisYear + 1,
    );
}

/**
 * A careers subdomain is a careers page at its own root.
 *
 * `careers.pif.gov.sa/` has an empty path, so `isHomePath` called it a
 * homepage — and it is the homepage, of a recruitment portal. Labelling it
 * `site_root` did two things wrong at once: the interface told the reader the
 * only page it watches for the Public Investment Fund is a corporate homepage,
 * and `alwaysJudge` stopped exempting it, so the single careers portal of a
 * tier-S organisation was handed to the cost filter like any news page.
 *
 * The label is on the leftmost host component only. `jobs.x.gov.sa` qualifies;
 * `www.jobsite-review.com` does not.
 */
const CAREERS_HOST = /^(?:careers?|jobs?|tawheed|recruit(?:ment)?|hiring|coop|training)$/i;

function isCareersHost(u: URL): boolean {
  return CAREERS_HOST.test(u.hostname.split(".")[0] ?? "");
}

export function typeFor(url: string, current: SourceType): SourceType {
  const u = new URL(url);
  if (
    /career|job|coop|training|recruit|تدريب|وظائف/i.test(decodeURI(url)) &&
    (!isHomePath(u) || isCareersHost(u)) &&
    !isDatedArticle(u)
  ) {
    return "careers_page";
  }
  if (isHomePath(u)) return "site_root";
  // A dated article is a single news item, not a page that will be updated with
  // the next intake. It is still watched; it just stops claiming to be a
  // careers page and stops buying a free pass through the cost filter.
  if (isDatedArticle(u)) return "announcement_page";
  return current === "site_root" ? "announcement_page" : current;
}

/**
 * The city list, with the things that are not cities taken out.
 *
 * `cities` is one of the four fields still copied by the model, and the live
 * dataset showed what that costs: alongside الرياض and جدة it held
 * "المملكة العربية السعودية", "Saudi Arabia", "جميع أنحاء المملكة",
 * "Southern Area Oil Operations" and "مدَن" — a country, a country again, a
 * phrase meaning "everywhere", a department, and an organisation's own name.
 *
 * Two harms follow. The filter dropdown offers them as choices that match one
 * card each, and the +5 "in your city" bonus can fire on a country, which makes
 * a nationwide programme score as though it were down the road.
 *
 * A country-level phrase is dropped outright: it is true and useless, since
 * every announcement in the dataset is in Saudi Arabia. A Latin spelling of a
 * city that is also written in Arabic is folded into the Arabic, so "Riyadh"
 * and "الرياض" stop being two entries in one dropdown.
 *
 * Anything else is kept exactly as written. A small city this list has never
 * heard of is still a city, and guessing it away would be the same mistake in
 * the other direction.
 */
const NOT_A_CITY =
  /^(?:المملكة(?:\s+العربية\s+السعودية)?|السعودية|جميع\s+أنحاء\s+المملكة|كافة\s+المناطق|جميع\s+المناطق|عن\s+بعد|remote|saudi\s*arabia|ksa|kingdom(?:\s+of\s+saudi\s+arabia)?|nationwide|various|multiple\s+locations)$/i;

const LATIN_CITY: Record<string, string> = {
  riyadh: "الرياض",
  jeddah: "جدة",
  jiddah: "جدة",
  dammam: "الدمام",
  khobar: "الخبر",
  alkhobar: "الخبر",
  dhahran: "الظهران",
  makkah: "مكة المكرمة",
  mecca: "مكة المكرمة",
  madinah: "المدينة المنورة",
  medina: "المدينة المنورة",
  taif: "الطائف",
  jubail: "الجبيل",
  yanbu: "ينبع",
  abha: "أبها",
  tabuk: "تبوك",
  buraydah: "بريدة",
  hail: "حائل",
  najran: "نجران",
  jazan: "جازان",
  jizan: "جازان",
  qassim: "القصيم",
  ahsa: "الأحساء",
  hofuf: "الهفوف",
};

export function cleanCities(cities: string[]): string[] {
  const out: string[] = [];
  for (const raw of cities) {
    const city = raw.trim().replace(/\s+/g, " ");
    if (city === "" || NOT_A_CITY.test(city)) continue;
    const latin = LATIN_CITY[city.toLowerCase().replace(/^al[- ]/, "")];
    const value = latin ?? city;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
