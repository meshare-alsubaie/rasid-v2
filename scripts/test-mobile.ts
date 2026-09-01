/**
 * Nothing is cut off the right edge of a phone.
 *
 * The owner said the app "يلفّ على اليمين". The handoff notes recorded "زحف
 * أفقي للصفحة: لا". He was right and the notes were wrong: measured on the
 * shipped stylesheet, the document was 476px wide and could be dragged 101px
 * sideways at 375px, and 156px at 320px. The masthead, the words "لا شيء
 * مفتوح اليوم", and the first words of every sentence in the honesty panel
 * were off the screen.
 *
 * A first measurement inside a different browser reported zero horizontal
 * travel and nearly sent this the wrong way, which is why the check below asks
 * by moving the page rather than by reading a width: `scrollWidth` disagrees
 * with itself across engines in RTL, and what a reader can reach does not.
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
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

const WIDTHS = [320, 375, 414];

/**
 * Serve the built site ourselves unless told otherwise.
 *
 * The first version pointed at the dev server and failed the moment it was not
 * running - "could not load localhost:5173" - which is a gate reporting a
 * defect that does not exist. A check nobody can run without remembering a
 * second command is a check that stops being run.
 *
 * It also means this measures `dist`, which is what actually ships, rather
 * than the dev server's unbundled version of it.
 */
async function serveBuild(): Promise<{ url: string; stop: () => void }> {
  if (process.env.RASID_APP_URL) {
    return { url: process.env.RASID_APP_URL, stop: () => {} };
  }
  if (!existsSync("dist/index.html")) {
    console.log("  no dist/ yet, building it first");
    const built = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
      stdio: "ignore",
    });
    if (built.status !== 0) throw new Error("vite build failed");
  }

  const port = 4174;
  const child = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "preview", "--port", String(port), "--strictPort"],
    { stdio: "ignore" },
  );
  const url = `http://localhost:${port}/`;

  // Poll rather than sleep: the server is ready when it answers, and a fixed
  // wait is either too short on a cold start or wasted on a warm one.
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return { url, stop: () => child.kill() };
    } catch {
      // not up yet
    }
  }
  child.kill();
  throw new Error(`the preview server never answered on ${url}`);
}

const server = await serveBuild();
const URL = server.url;

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
server.stop();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
