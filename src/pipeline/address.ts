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
const ANCHOR = /^[A-Za-z0-9_:.-]*$/;

export function addressOf(url: string): string {
  const hash = url.indexOf("#");
  const base = (hash === -1 ? url : url.slice(0, hash)).replace(/\/+$/, "").toLowerCase();
  if (hash === -1) return base;

  const fragment = url.slice(hash + 1);
  if (fragment === "" || ANCHOR.test(fragment)) return base;
  return `${base}#${fragment.replace(/\/+$/, "").toLowerCase()}`;
}
