/**
 * Nothing is cut off the right edge of a phone.
 *
 * The owner said the app "يلفّ على اليمين", the handoff notes recorded "زحف
 * أفقي للصفحة: لا", and both were right about different things. Measured at
 * 375px: the page cannot be scrolled sideways at all - `scrollX` will not move
 * - and the content was 101px wider than the screen anyway. So the overflow
 * was not a scrollbar to drag. It was text that had simply left the building.
 * The masthead, the words "لا شيء مفتوح اليوم", and the first words of every
 * sentence in the honesty panel were off-screen and unreachable.
 *
 * Four defaults caused it, each of them one level down from the last, which is
 * why fixing one never fixed the page:
 *   - `.cards` had a bare `display: grid`, and an implicit `auto` track is
 *     never narrower than its widest item's min-content
 *   - `.card` had the same, one level down
 *   - `.card .meta` demanded `minmax(8rem, 1fr)` for three columns, 398px, in
 *     a 351px card
 *   - `.skip-link` was parked at `inset-inline-start: -9999px`, which in an RTL
 *     document pushes the page instead of hiding it
 *
 * None of those is visible in the source. All four are visible in a browser at
 * 375px, so that is where this looks.
 *
 *   npm run test:mobile
 */
import { chromium } from "playwright";

/*
 * A hand-written shim for the handful of browser globals used below.
 *
 * The obvious move is `/// <reference lib="dom" />`, and it does silence the
 * "document does not exist" errors - by adding the DOM library to the whole
 * program, where it immediately collided with linkedom's own DOM types and
 * broke extract.ts, discover-links.ts and watch-sitemaps.ts. `lib` has no file
 * scope, so a fix for one file is a change to every file.
 *
 * The other obvious move is passing the snippet as a string, which puts the
 * one part of this file that can actually be wrong beyond the type checker
 * entirely. This is the narrow version: only what is used, checked, and
 * contained.
 */
interface DomEl {
  readonly tagName: string;
  readonly className: unknown;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}
interface DomWindow {
  document: {
    documentElement: { clientWidth: number; scrollWidth: number };
    querySelectorAll(selector: string): ArrayLike<DomEl>;
  };
  getComputedStyle(el: DomEl): { overflowX: string };
  scrollTo(options: { left: number; top: number; behavior: string }): void;
  readonly scrollX: number;
}

const URL = process.env.RASID_APP_URL ?? "http://localhost:5173/";
const WIDTHS = [320, 375, 414];

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();

for (const width of WIDTHS) {
  console.log(`\n${width}px`);
  const page = await browser.newPage({ viewport: { width, height: 812 } });
  try {
    await page.goto(URL, { waitUntil: "networkidle", timeout: 30_000 });
  } catch {
    console.log(`  FAIL  could not load ${URL}. Start the dev server: npm run dev`);
    failures++;
    await page.close();
    continue;
  }
  // The dataset arrives by fetch, so the cards exist a moment after load.
  await page.waitForSelector("li.card", { timeout: 20_000 }).catch(() => null);

  const m = await page.evaluate(() => {
    const w = globalThis as unknown as DomWindow;
    const de = w.document.documentElement;
    const offenders: { sel: string; over: number }[] = [];
    for (const el of Array.from(w.document.querySelectorAll("main, main *"))) {
      if (el.scrollWidth <= el.clientWidth + 2 || el.clientWidth === 0) continue;
      // A container that scrolls its own content is doing the right thing.
      const overflowX = w.getComputedStyle(el).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") continue;
      const cls =
        typeof el.className === "string" && el.className
          ? "." + el.className.trim().split(/\s+/)[0]
          : "";
      offenders.push({ sel: el.tagName.toLowerCase() + cls, over: el.scrollWidth - el.clientWidth });
    }
    return {
      viewport: de.clientWidth,
      docScrollWidth: de.scrollWidth,
      cards: w.document.querySelectorAll("li.card").length,
      domElements: w.document.querySelectorAll("*").length,
      offenders: offenders.sort((a, b) => b.over - a.over).slice(0, 5),
    };
  });

  check("the dataset actually rendered", m.cards > 0, `${m.cards} cards`);
  check(
    "the page is no wider than the screen",
    m.docScrollWidth <= m.viewport + 1,
    `${m.docScrollWidth}px of ${m.viewport}px`,
  );
  check(
    "and nothing inside it overflows uncontained",
    m.offenders.length === 0,
    m.offenders.map((o) => `${o.sel} +${o.over}px`).join(", "),
  );

  /*
   * Checked by moving the page rather than by reading a width, because
   * `body.scrollWidth` lies in RTL: it reported a 476px document that could
   * not be scrolled by a single pixel. What matters to a reader is whether the
   * clipped part can be reached, and this is the only honest way to ask.
   */
  const travel = await page.evaluate(async () => {
    const w = globalThis as unknown as DomWindow;
    w.scrollTo({ left: -4000, top: 0, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 60));
    const a = w.scrollX;
    w.scrollTo({ left: 4000, top: 0, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 60));
    const b = w.scrollX;
    w.scrollTo({ left: 0, top: 0, behavior: "instant" });
    return Math.abs(b - a);
  });
  check(
    "there is nothing off-screen for a reader to have to reach",
    travel < 2,
    `the page can be dragged ${travel}px sideways`,
  );

  if (width === 375) {
    // Recorded rather than asserted: it is a real cost on a phone and the
    // number should be visible when it grows, but no threshold here would be
    // anything but invented.
    console.log(`  note  ${m.domElements} DOM elements for ${m.cards} cards`);
  }

  await page.close();
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
