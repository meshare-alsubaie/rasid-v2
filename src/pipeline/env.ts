/**
 * Read `.env` into the process, once, at the top of an entry point.
 *
 * Every secret this project has now lives on the owner's own machine: the
 * notification keys and the device subscription that says where his phone is.
 * They are in `.env`, which is gitignored, and nothing was reading it.
 *
 * That gap was invisible in exactly the way this project keeps being bitten
 * by. Run by hand from a shell that happened to have the values exported, the
 * notifier worked. Run by Task Scheduler - which starts with a bare
 * environment - `sendPush` found no subscription, printed "push: skipped", and
 * the round went green. The alert that a window had opened would simply not
 * have happened, and the log would have looked fine.
 *
 * Deliberately narrow: it does not overwrite a value already in the
 * environment, so CI secrets and a one-off `RASID_X=... npm run ...` still win,
 * and it never throws. A missing `.env` is the normal case on a machine that
 * only collects.
 */
import { existsSync, readFileSync } from "node:fs";

let loaded = false;

export function loadEnvFile(path = ".env"): string[] {
  if (loaded) return [];
  loaded = true;
  if (!existsSync(path)) return [];

  const added: string[] = [];
  let text: string;
  try {
    // The BOM is stripped because Windows editors add one silently, and with it
    // in place the first line reads as "﻿VAPID_PUBLIC_KEY" — a variable
    // name nothing asks for, so the first secret in the file is simply absent.
    // collect.ts already strips it when reading JSON for exactly this reason.
    text = readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch {
    return [];
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    /*
     * Quotes are stripped, but nothing else is interpreted. A push
     * subscription is a JSON object on one line, full of braces, colons and
     * base64 - so any attempt to be clever about escapes would corrupt the one
     * value that matters most here.
     */
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      added.push(key);
    }
  }
  return added;
}
