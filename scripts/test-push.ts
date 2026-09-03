/**
 * The delivery chain, from the sender's exit code to the banner on the phone.
 *
 * This is the one part of the project the whole thing is judged on: an
 * announcement that does not reach the phone within six hours is a failure
 * however green everything else looks. It went dead for forty-seven hours, over
 * 282 failed sends, while every round reported success — so the checks here are
 * about whether a failure can be *seen*, not only whether a success works.
 *
 * The service worker is executed rather than read. It is browser code, so the
 * globals it expects are stubbed; that is enough to catch the two defects that
 * were live, both of which are ordinary JavaScript mistakes that no amount of
 * looking at the file had caught.
 *
 *   npm run test:push
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

/* ---------- a stubbed browser, just enough to run the worker ---------- */

interface Shown {
  title: string;
  body: string;
}

function runServiceWorker(opts: { cacheThrows: boolean }): {
  shown: Shown[];
  messages: { type: string; at: string }[];
  threw: string | null;
} {
  const shown: Shown[] = [];
  const messages: { type: string; at: string }[] = [];
  const listeners = new Map<string, (event: unknown) => void>();

  const store = new Map<string, string>();
  const fakeCache = {
    put: async (req: { url?: string } | string, res: { text: () => Promise<string> }) => {
      if (opts.cacheThrows) throw new Error("QuotaExceededError");
      store.set(String(typeof req === "string" ? req : req.url), await res.text());
    },
    keys: async () => [...store.keys()],
    delete: async (k: string) => store.delete(k),
    match: async () => undefined,
    addAll: async () => undefined,
  };

  const self = {
    addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    registration: {
      showNotification: async (title: string, o: { body?: string }) => {
        shown.push({ title, body: o.body ?? "" });
      },
    },
    clients: {
      matchAll: async () => [
        { postMessage: (m: { type: string; at: string }) => messages.push(m) },
      ],
      claim: async () => undefined,
      openWindow: async () => undefined,
    },
    skipWaiting: async () => undefined,
    location: { origin: "https://example.test" },
  };

  const caches = {
    open: async () => fakeCache,
    keys: async () => [],
    delete: async () => true,
    match: async () => undefined,
  };

  const src = readFileSync("public/sw.js", "utf8");
  let threw: string | null = null;
  try {
    // eslint-disable-next-line no-new-func
    const run = new Function(
      "self",
      "caches",
      "Request",
      "Response",
      "console",
      `${src}\nreturn { announce: typeof announce === "function" ? announce : null };`,
    );
    const api = run(
      self,
      caches,
      class {
        url: string;
        constructor(u: string) {
          this.url = u;
        }
      },
      class {
        private readonly b: string;
        constructor(b: string) {
          this.b = b;
        }
        async text(): Promise<string> {
          return this.b;
        }
      },
      { warn: () => undefined, log: () => undefined, error: () => undefined },
    ) as { announce: ((p: unknown, v: string) => Promise<void>) | null };

    if (api.announce === null) throw new Error("announce() is not declared in sw.js");
    // Node has no top-level await here, so the promise is resolved by the caller
    // via a synchronous drain: announce only awaits already-resolved stubs.
    void api.announce({ title: "اختبار", body: "نص" }, "push");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  return { shown, messages, threw };
}

console.log("the service worker survives a push");
{
  const ok = runServiceWorker({ cacheThrows: false });
  check("it loads and announce() runs without throwing", ok.threw === null, ok.threw ?? "");

  /*
   * The seeded fault this replaces: `announce` read a variable named `entry`
   * that was declared inside `recordArrival`. Every push threw a ReferenceError
   * after the banner was shown, so the arrival was never recorded, the app's own
   * "no push in seven days" watchdog had nothing to count from, and could never
   * fire. The channel then went silent for two days with nothing to say so.
   */
  const src = readFileSync("public/sw.js", "utf8");
  const announceBody = src.slice(src.indexOf("async function announce"));
  check(
    "announce() does not reach for a variable that lives in another function",
    !/\bentry\.at\b/.test(announceBody),
    "`entry` is local to recordArrival",
  );
  check(
    "the banner is shown before anything is written down",
    announceBody.indexOf("showNotification") < announceBody.indexOf("recordArrival"),
    "a diagnostic must never be able to cancel the thing it is diagnosing",
  );
}

console.log("\nand it survives a device that cannot write the log");
{
  const degraded = runServiceWorker({ cacheThrows: true });
  check(
    "the notification is still shown when the push log cannot be written",
    degraded.shown.length === 1,
    `${degraded.shown.length} shown`,
  );
  check("and nothing throws out of announce()", degraded.threw === null, degraded.threw ?? "");
}

/* ---------- the sender says so when nothing arrives ---------- */

console.log("\na send that reaches nobody is not a successful round");
{
  const src = readFileSync("scripts/notify.ts", "utf8");
  check(
    "the push status code is read, not just the message",
    /statusCode/.test(src),
    "410 means the subscription is gone; 403 means the keys changed; they need different answers",
  );
  check("a dead channel exits non-zero", /pushChannelDown[\s\S]{0,400}process\.exit\(1\)/.test(src));
  check(
    "and it is written where the app can read it",
    // The sender writes the file; the app loads it by name, with or without the
    // extension depending on how the loader is spelled.
    /notify-health\.json/.test(src) && /notify-health/.test(readFileSync("src/app/data.ts", "utf8")),
    "an exit code only reaches a log file nobody opens while things look fine",
  );
  check(
    "and the app renders it rather than merely loading it",
    /notifyHealth[\s\S]{0,400}state === "down"/.test(readFileSync("src/app/main.ts", "utf8")),
    "a field on an object nobody draws is the same silence in a different place",
  );

  /*
   * Executed, not asserted from the source. The subscription in .env is the one
   * the phone registered, and this proves the sender reports the truth about it
   * either way: exit 0 when it can deliver, exit 1 when it cannot.
   */
  const run = spawnSync("npx", ["tsx", "scripts/notify.ts", "--dry-run"], {
    encoding: "utf8",
    shell: true,
    timeout: 120_000,
  });
  check("a dry run still exits cleanly", run.status === 0, `exit ${String(run.status)}`);
}

console.log("\nand the site is actually republished");
{
  const src = readFileSync("scripts/watch.ts", "utf8");
  check("the watcher has a publish step at all", /function publish\(/.test(src));
  check("it pushes", /"push",\s*"--quiet",\s*"origin"/.test(src));
  check(
    "and it only ever commits data/",
    /git\(\["add", "--", "data"\]\)/.test(src),
    "a watcher must not carry up a source file someone is editing",
  );
}

console.log(`\n${failures === 0 ? "the delivery chain reports itself honestly" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
