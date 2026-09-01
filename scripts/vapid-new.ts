/**
 * A fresh notification key pair.
 *
 * The private half is written to `.env`, which is gitignored, and is never
 * printed: it is the one value that actually signs a push, and a key echoed
 * into a terminal is a key in a scrollback buffer.
 *
 * The public half is printed, because it belongs in src/app/vapid.ts, in the
 * repository, shipped to every visitor. See that file for why that is right.
 *
 * Rotating invalidates every existing subscription: a subscription is bound to
 * the key that created it, so every device has to be registered again. Do not
 * run this to fix a notification that did not arrive.
 *
 *   npm run vapid:new
 */
import { readFileSync, writeFileSync } from "node:fs";
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

let env = "";
try {
  env = readFileSync(".env", "utf8");
} catch {
  // No .env yet is the normal case on a fresh clone.
}
const kept = env
  .split(/\r?\n/)
  .filter((l) => l.trim() && !/^VAPID_(PUBLIC|PRIVATE)_KEY=/.test(l))
  .join("\n");

writeFileSync(
  ".env",
  `${kept ? kept + "\n" : ""}VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`,
  "utf8",
);

console.log("A new pair is in .env. The private half was not printed.\n");
console.log("Paste this into BUILT_IN in src/app/vapid.ts:\n");
console.log(keys.publicKey);
console.log("\nEvery device already registered must register again.");
