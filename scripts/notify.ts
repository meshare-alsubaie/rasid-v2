/**
 * Send what the collection run made newly true.
 *
 * The "before" state comes from git, which is the point of committing the
 * dataset: the previous commit is the previous run, with no extra bookkeeping
 * and a full history behind it.
 *
 * Every channel is optional and every skip is printed. A missing key means
 * "this channel is off", never a silent no-op that looks like "there was
 * nothing to say".
 *
 *   npm run notify              send
 *   npm run notify -- --dry-run decide and print, send nothing
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import webpush from "web-push";
import { showToast } from "../src/pipeline/toast";
import {
  decide,
  inQuietHours,
  split,
  LOG_RETENTION_DAYS,
  type Notice,
  type NoticeLogEntry,
} from "../src/pipeline/notify";
import type { Opportunity, Organisation, SourceHealth } from "../src/types";
import { loadEnvFile } from "../src/pipeline/env";

/* Secrets live in a gitignored .env on this machine. Read before anything
 * asks process.env for one: a scheduled task starts with a bare environment,
 * and a missing subscription makes the notifier skip silently. */
loadEnvFile();

const DRY = process.argv.includes("--dry-run");
/** Prove the whole chain works, without waiting for a real announcement. */
const TEST = process.argv.includes("--test");
const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

/**
 * The file as it stood before this run's data landed. Empty on the first run.
 *
 * Which commit that is depends on how the run was started, and getting it wrong
 * silenced the app completely. When the collection happened here, the new data
 * is still uncommitted, so `HEAD` is the previous state and is right. But the
 * machine that can actually reach the .gov.sa sites collects locally, commits,
 * and pushes — and the CI run that answers that push has the new data *in*
 * `HEAD`. Comparing `HEAD` to the working tree then compares a commit with
 * itself: every record looks unchanged, `decide` finds nothing newly true, and
 * not one notification is ever sent by the only collector that works.
 *
 * So the workflow passes the pre-push SHA in RASID_BEFORE_REF for that case.
 */
const BEFORE_REFS = [process.env.RASID_BEFORE_REF?.trim(), "HEAD~1", "HEAD"].filter(
  (r): r is string => Boolean(r),
);

function fromGit<T>(path: string): T[] {
  for (const ref of BEFORE_REFS) {
    try {
      return JSON.parse(
        execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" }),
      ) as T[];
    } catch {
      // A shallow clone may not hold the exact pre-push commit; the next ref is
      // still a truthful "before", and the sent-log below stops any repeat.
    }
  }
  return [];
}

const orgs = read<Organisation>("data/organisations.json");
const after = read<Opportunity>("data/opportunities.json");
const healthAfter = read<SourceHealth>("data/health.json");
const before = fromGit<Opportunity>("data/opportunities.json");
const healthBefore = fromGit<SourceHealth>("data/health.json");

const names = new Map(orgs.map((o) => [o.id, o.nameAr]));
const now = new Date();

const fresh = decide({
  before,
  after,
  healthBefore,
  healthAfter,
  nameOf: (id) => names.get(id) ?? id,
  threshold: Number(process.env.RASID_THRESHOLD ?? 60),
});

/*
 * Anything decided but not yet sent, carried over from earlier runs.
 *
 * This queue exists because of a bug that would have cost a real deadline.
 * `decide` compares this run against the previous commit, so a notice is only
 * ever produced once, on the run where the thing became true. During quiet
 * hours nothing is pushed — and by the next run the announcement was no longer
 * new, so the notice was never regenerated and simply vanished. An announcement
 * that opened at one in the morning would have been silently swallowed.
 *
 * So an undelivered notice is now kept until it is actually delivered. Sent
 * keys still guard against repeats, and the day-scoped keys mean a stale entry
 * eventually stops matching anything rather than nagging forever.
 */
const PENDING_FILE = "data/pending-notices.json";
/** A notice nobody could deliver for a week is stale news, not a pending one. */
const PENDING_TTL_MS = 7 * 86_400_000;
type Held = Notice & { queuedISO: string };

/**
 * A notice about a window that is still open does not go stale.
 *
 * Age alone was the whole test, and it threw away things that were still true.
 * The daily cap is six; the overflow is routed to the email digest; the digest
 * is off because no key is set — so anything past the sixth notice went nowhere
 * at all and was deleted seven days later, unsent and unmentioned. Four real
 * announcements were four days from exactly that.
 *
 * So the question is no longer "how old is this" but "is it still true". A
 * notice whose opportunity is still open survives; one whose window has closed,
 * or whose record has gone, is genuinely stale and is dropped on the old timer.
 */
const stillOpen = new Set(
  after
    .filter((o) => o.status === "open" || o.status === "closing_soon" || o.status === "announced_not_open")
    .map((o) => o.id),
);
const aboutALiveOpportunity = (key: string): boolean =>
  [...stillOpen].some((id) => key.includes(id));

const carriedRaw = read<Held>(PENDING_FILE);
const carried = carriedRaw.filter((n) => {
  const age = now.getTime() - Date.parse(n.queuedISO);
  if (age < PENDING_TTL_MS) return true;
  return aboutALiveOpportunity(n.key);
});
const expired = carriedRaw.length - carried.length;
if (expired > 0) {
  console.log(`${expired} held notice(s) dropped: past a week and no longer about an open window`);
}
const seen = new Set<string>();
const notices: Held[] = [...carried, ...fresh.map((n) => ({ ...n, queuedISO: now.toISOString() }))]
  .filter((n) => !seen.has(n.key) && seen.add(n.key));

const quietStart = Number(process.env.RASID_QUIET_START ?? 23);
const quietEnd = Number(process.env.RASID_QUIET_END ?? 7);
const quiet = inQuietHours(now, quietStart, quietEnd);

const log = read<NoticeLogEntry>("data/notifications.json");
const { push, digestOnly } =
  TEST
    ? {
        push: [
          {
            key: `test:${now.toISOString()}`,
            kind: "new_relevant" as const,
            title: "🟢 راصد يعمل",
            body: "هذه تجربة. حين تُفتح نافذة حقيقية سيصلك تنبيه بهذا الشكل.",
            weight: 1,
          },
        ],
        digestOnly: [],
      }
    : split(notices, log, now, quiet);

console.log(
  `notices: ${fresh.length} new, ${carried.length} carried over, ${push.length} to push, ${digestOnly.length} to digest`,
);
if (quiet) {
  console.log(
    `quiet hours ${quietStart}:00-${quietEnd}:00 Riyadh, nothing is pushed now; it is held, not dropped`,
  );
}
for (const n of [...push, ...digestOnly]) console.log(`  ${n.kind.padEnd(14)} ${n.title} — ${n.body}`);

/* ---------- web push ---------- */

const vapidPublic = process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
const subscriptionRaw = process.env.RASID_PUSH_SUBSCRIPTION;
const contact = process.env.RASID_CONTACT;

/**
 * Why the channel is down, when it is down.
 *
 * The library throws a `WebPushError` carrying the status code the push service
 * returned, and the code is the whole diagnosis: 404 and 410 mean the browser
 * threw the subscription away and a new one must be registered on the phone;
 * 403 means the VAPID key pair no longer matches the one the subscription was
 * created with; 400 means the request itself was malformed. All four printed
 * the same unhelpful sentence, and 282 of them went by without anyone being
 * able to tell which had happened.
 */
function pushDiagnosis(err: unknown): { status: number | null; sentence: string } {
  const status =
    typeof err === "object" && err !== null && "statusCode" in err
      ? Number((err as { statusCode: unknown }).statusCode)
      : null;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 404 || status === 410) {
    return {
      status,
      sentence: `the phone's subscription is gone (HTTP ${status}). Open the app on the phone and enable notifications again; nothing will arrive until you do.`,
    };
  }
  if (status === 403) {
    return {
      status,
      sentence: "the VAPID key pair does not match the subscription (HTTP 403). The keys were regenerated after the phone subscribed, so the phone must subscribe again.",
    };
  }
  if (status === 400) {
    return { status, sentence: `the push service rejected the request (HTTP 400): ${message}` };
  }
  return { status, sentence: status === null ? message : `HTTP ${status}: ${message}` };
}

/** True when every push this run attempted failed. Read at the exit. */
let pushChannelDown = false;
/** The sentence to show the user in the app when it is. */
let pushDownReason = "";

/**
 * Returns the keys that actually went out, not how many.
 *
 * Counting was wrong in a way that lost mail in both directions: the caller
 * logged `push.slice(0, sent)`, so when the second of three sends failed, the
 * first two positions were logged — marking the failed one as delivered, never
 * to be retried — while the third, which did go out, was left unlogged and sent
 * again next run. Only the keys that succeeded are truthful.
 */
async function sendPush(items: Notice[]): Promise<string[]> {
  if (items.length === 0) return [];
  if (!vapidPublic || !vapidPrivate || !subscriptionRaw) {
    console.log("push: skipped, VAPID keys or the device subscription are not set");
    return [];
  }
  webpush.setVapidDetails(contact ? `mailto:${contact}` : "https://github.com/", vapidPublic, vapidPrivate);
  const subscription = JSON.parse(subscriptionRaw) as webpush.PushSubscription;

  const sent: string[] = [];
  for (const n of items) {
    try {
      if (!DRY) {
        /*
         * A tag per notice, not one for all of them.
         *
         * The service worker falls back to the constant tag "rasid", and a tag
         * is what the operating system uses to decide that a new notification
         * *replaces* an older one. Two alerts sent in the same second therefore
         * left one banner. On 30 August two went out together, and the one that
         * survived was the bank at relevance 65 — the cybersecurity programme
         * at 95 was the one it overwrote. The daily cap of six means nothing if
         * only the last of them is visible.
         */
        await webpush.sendNotification(
          subscription,
          JSON.stringify({ title: n.title, body: n.body, tag: n.key }),
        );
      }
      sent.push(n.key);
    } catch (err) {
      // A dead subscription is worth saying out loud: it means his phone has
      // stopped receiving and he would otherwise never find out.
      const { status, sentence } = pushDiagnosis(err);
      console.log(`push failed for ${n.key}: ${sentence}`);
      pushDownReason =
        status === 404 || status === 410
          ? "اشتراك الجوّال انتهى، فالمتصفّح تخلّص منه. افتح التطبيق على جوّالك واضغط «فعّل التنبيهات» مرّة أخرى."
          : status === 403
            ? "مفاتيح الإشعارات تغيّرت بعد تسجيل الجوّال، فلم يعد الاشتراك صالحاً. أعد التفعيل من جوّالك."
            : `خدمة الإشعارات ردّت بخطأ (${status ?? "بلا رمز"}). الإشعارات محفوظة وستُعاد المحاولة.`;
      if (status === 404 || status === 410 || status === 403) {
        // No point hammering a subscription the service has told us is gone.
        console.log("push: the rest of this run's notices are held rather than retried");
        break;
      }
    }
  }

  /*
   * A run that tried to push and got nothing through is a failed run, and the
   * exit code has to say so.
   *
   * It did not. Every failure was caught, printed into a log file that is
   * excluded from git, and the process exited 0 — so the watcher wrote
   * `notify exit 0` a hundred and thirty-nine times while the channel had been
   * dead for forty-seven hours and fifty-one notices sat unsent. Nothing
   * anywhere distinguished a healthy round from total silence. That is the
   * stale green light this project was built to refuse, sitting in the one
   * component whose failure the whole thing is judged on.
   */
  if (sent.length === 0 && !DRY) {
    pushChannelDown = true;
    console.log(
      `push: ${items.length} notice(s) were due and none reached the phone. Holding them for the next run.`,
    );
  }
  return sent;
}

/* ---------- email digest ---------- */

async function sendDigest(items: Notice[]): Promise<boolean> {
  if (items.length === 0) return false;
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) {
    console.log("digest: skipped, RESEND_API_KEY or NOTIFY_EMAIL is not set");
    return false;
  }
  const body = items.map((n) => `<p><strong>${n.title}</strong><br>${n.body}</p>`).join("");
  if (DRY) return true;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "RASID <onboarding@resend.dev>",
      to: [to],
      subject: `راصد — ${items.length} تحديث`,
      html: `<div dir="rtl" lang="ar">${body}</div>`,
    }),
  });
  if (!res.ok) {
    console.log(`digest failed: HTTP ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

/* ---------- Windows toast ---------- */

/**
 * The same notices, on the machine he is sitting at.
 *
 * Web push needs a browser process alive to receive it and he is usually in a
 * full-screen game with none open, so the phone alone leaves a hole exactly
 * where he spends most of the day. This closes it, and the two channels fail
 * for entirely unrelated reasons, which is the reason to have both.
 *
 * Deliberately outside the sent-log. The log exists so a failed send is retried
 * and a successful one is never repeated, and the thing that must not be lost
 * is the phone: it is what reaches him away from the desk. A toast that
 * appeared must not be able to mark a notice delivered and stop the push being
 * tried again. Repeating a toast for a notice still waiting on push is the
 * lesser fault, and it errs towards telling him.
 */
/**
 * Returns the keys that were actually shown, so they are not shown again.
 *
 * The toast deliberately sits outside the delivery contract: it must never mark
 * a notice delivered, because the phone is what matters and a banner on a
 * machine he is not sitting at proves nothing. But "outside the contract" was
 * read as "outside all memory", so while the push channel was down the same six
 * notices were toasted on every round — six banners a minute, repeating what
 * they had already said, which is how a person learns to ignore them.
 *
 * They are logged now under their own channel, which retires nothing.
 */
async function showToasts(items: Notice[], alreadyToasted: Set<string>): Promise<string[]> {
  if (items.length === 0 || DRY) return [];
  const shown: string[] = [];
  for (const n of items) {
    if (alreadyToasted.has(n.key)) continue;
    const r = await showToast(n.title, n.body);
    if (r.ok) shown.push(n.key);
    else console.log(`toast: ${n.key} not shown (${r.reason})`);
  }
  return shown;
}

const pushedKeys = await sendPush(push);
const alreadyToasted = new Set(log.filter((e) => e.via === "toast").map((e) => e.key));
const toastedKeys = await showToasts(push, alreadyToasted);
const toasted = toastedKeys.length;
const digested = await sendDigest(digestOnly);
console.log(
  `sent: ${pushedKeys.length} push, ${toasted} toast, ${digested ? "1" : "0"} digest${DRY ? " (dry run)" : ""}`,
);

/* Only what actually went out is logged, so a failed send is retried next run. */
if (!DRY && !TEST) {
  const sentKeys = new Set([
    ...pushedKeys,
    ...(digested ? digestOnly.map((n) => n.key) : []),
  ]);
  /*
   * `via` separates the two channels in the log, because the daily cap in
   * `split` counts entries for today and the cap is six *pushes*. Before this,
   * a quiet night that emailed nine items filled the day's budget and demoted
   * every real push the next morning to the digest.
   */
  const pushedSet = new Set(pushedKeys);
  const merged = [
    ...log,
    ...[...sentKeys].map((key) => ({
      key,
      sentISO: now.toISOString(),
      via: pushedSet.has(key) ? ("push" as const) : ("digest" as const),
    })),
    // Recorded so it is not repeated. Retires nothing:  counts only
    // push and digest, so a toasted notice is still owed a real delivery.
    ...toastedKeys
      .filter((key) => !sentKeys.has(key))
      .map((key) => ({ key, sentISO: now.toISOString(), via: "toast" as const })),
  ]
    // Kept strictly longer than ANNOUNCE_WINDOW_DAYS, so a notice can never be
    // proposed again after the entry proving it was sent has been pruned.
    .filter((e) => Date.now() - Date.parse(e.sentISO) < LOG_RETENTION_DAYS * 86_400_000);
  writeFileSync("data/notifications.json", JSON.stringify(merged, null, 2) + "\n", "utf8");

  // Whatever did not go out waits for the next run rather than evaporating.
  const stillWaiting = notices.filter((n) => !sentKeys.has(n.key));
  writeFileSync(PENDING_FILE, JSON.stringify(stillWaiting, null, 2) + "\n", "utf8");
  if (stillWaiting.length > 0) {
    console.log(`held for the next run: ${stillWaiting.length}`);
  }
}

/*
 * The state of the notification channel, written where the app can read it.
 *
 * An exit code reaches the watcher's log, and the watcher's log is a file
 * nobody opens while things look calm. That is exactly how the channel stayed
 * dead for forty-seven hours: 282 failures, all of them printed somewhere that
 * is excluded from git, under a home screen that went on saying everything was
 * fine. The app has to be able to say "your phone is not receiving" without
 * anyone going to look for it, so the fact is written into the dataset itself.
 */
if (!DRY) {
  const priorState = (() => {
    try {
      return JSON.parse(readFileSync("data/notify-health.json", "utf8")) as {
        lastSuccessISO?: string | null;
      };
    } catch {
      return { lastSuccessISO: null };
    }
  })();

  /*
   * Three states, because "nothing was attempted" is not "it works".
   *
   * With two states this wrote `healthy` after a quiet-hours run in which no
   * push was even tried, and the status screen then said "the channel works,
   * the last send succeeded" while the phone's subscription had been dead for
   * two days. That is the same false green light this whole project is built to
   * refuse, reproduced in the very file that reports on it.
   *
   * `healthy` now requires a send that actually succeeded — this run, or a
   * previous one. Anything else is `untested`, which reads as what it is.
   */
  const state = pushChannelDown
    ? "down"
    : pushedKeys.length > 0 || priorState.lastSuccessISO
      ? "healthy"
      : "untested";

  writeFileSync(
    "data/notify-health.json",
    JSON.stringify(
      {
        lastAttemptISO: now.toISOString(),
        lastSuccessISO:
          pushedKeys.length > 0 ? now.toISOString() : (priorState.lastSuccessISO ?? null),
        state,
        reason: pushChannelDown
          ? pushDownReason
          : state === "untested"
            ? "لم يُرسَل أي إشعار بنجاح بعد، فلا دليل على أن جوّالك يستقبل. جرّب «إشعاراً الآن» من الإعدادات."
            : "",
        heldCount: notices.filter((n) => !pushedKeys.includes(n.key)).length,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/*
 * The exit code carries the one fact the watcher can act on.
 *
 * Zero has to mean "the notices that were due went out". A round where the push
 * channel is down is not that, and reporting it as success is how a dead
 * channel stayed invisible for two days: the failure was printed into
 * watch.log, which is gitignored and which nobody reads while things look fine.
 * A non-zero exit puts `notify exit 1` in the watcher's own line, which is the
 * line that is read.
 */
if (pushChannelDown) {
  console.log(
    "\nnotify is exiting non-zero because nothing reached the phone this run. The notices are held, not lost.",
  );
  process.exit(1);
}
