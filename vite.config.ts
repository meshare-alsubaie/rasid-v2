import { cp, mkdir } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";

/**
 * The dataset the pipeline commits to git is also the app's only backend.
 * In dev, Vite serves it straight from the repo root at /data/*.json. For a
 * build it has to be copied, because nothing imports it: the app fetches it at
 * runtime so a data-only commit republishes the site without a rebuild.
 */
/**
 * The four files the app actually fetches, and no others.
 *
 * `data.ts` loads exactly these. Everything else in data/ is pipeline
 * bookkeeping: page hashes, remembered verdicts, sitemap state, the sent-notice
 * log, the benchmark fixture.
 */
const SERVED = ["organisations", "aggregators", "opportunities", "health"];

/**
 * Served too, but the app must render without them.
 *
 * `notify-health` is how the app says "your phone is not receiving", which it
 * could not say at all while the channel was dead for forty-seven hours.
 * `score-basis` carries the one phrase that makes the relevance number honest
 * to somebody who is not the person it was computed for.
 *
 * Separate from the list above because a build must not fail over them: they are
 * written by the notifier and the collector respectively, so a fresh clone that
 * has run neither simply does not have them yet, and that is not an error.
 */
const SERVED_OPTIONAL = ["notify-health", "score-basis"];

const copyData = (): Plugin => ({
  name: "rasid-copy-data",
  apply: "build",
  closeBundle: async () => {
    /*
     * Copying the whole directory published 1.9 MB, of which 857 KB was never
     * requested by anything.
     *
     * `verification.json` alone is 529 KB and no line of the browser code
     * mentions it; `snapshots.json` is another 317 KB of content hashes. They
     * were shipped on every deploy because `cp -r` is easier to write than a
     * list. On a phone on mobile data that is most of a megabyte spent before
     * the first card is drawn, and none of it can ever be drawn.
     *
     * The list is explicit rather than an exclusion pattern, so a new pipeline
     * file is private by default and has to be added on purpose. That is also
     * the safer direction for a public site: `verdicts.json` and the notice log
     * are about what the owner has been told, and they are nobody else's
     * business.
     */
    await mkdir("dist/data", { recursive: true });
    for (const name of SERVED) {
      await cp(`data/${name}.json`, `dist/data/${name}.json`);
    }
    for (const name of SERVED_OPTIONAL) {
      try {
        await cp(`data/${name}.json`, `dist/data/${name}.json`);
      } catch {
        // Not written yet. The app treats an absent file as "no opinion", which
        // is different from a bad one and must not be reported as either.
      }
    }
  },
});

export default defineConfig({
  plugins: [copyData()],
  // GitHub Pages serves a project site from /<repo>/, so asset urls have to be
  // relative. Set to "/" if this ever moves to its own domain.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 5173 },
});
