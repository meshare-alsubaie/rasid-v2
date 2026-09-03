/**
 * One screen that answers "is this thing actually working".
 *
 * Everything else in this project reports on a part: a gate says one property
 * holds, a log says one round ran, a probe says what one machine could reach.
 * None of them answers the question the owner actually has, which is whether he
 * can rely on this to tell him about a window before it shuts.
 *
 * So this reads the real files and says what is true right now, in Arabic, in
 * the order that matters: can it see, can it judge, can it reach the phone. A
 * line that cannot be verified is not printed.
 *
 *   npm run status
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Opportunity, Organisation, SourceHealth } from "../src/types";

const read = <T>(p: string): T[] =>
  JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T[];

const readOne = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
};

const ok = (s: string): string => `  ✅ ${s}`;
const bad = (s: string): string => `  ❌ ${s}`;
const warnLine = (s: string): string => `  ⚠️  ${s}`;

const orgs = read<Organisation>("data/organisations.json");
const health = read<SourceHealth>("data/health.json");
const opps = read<Opportunity>("data/opportunities.json");
const notify = readOne<{ state: string; reason: string; heldCount: number; lastSuccessISO: string | null }>(
  "data/notify-health.json",
);

let problems = 0;
const say = (line: string): void => {
  if (line.startsWith("  ❌")) problems++;
  console.log(line);
};

console.log("\n════ راصد · هل يعمل الآن ════\n");

/* ---------- ١ · هل يرى ---------- */

console.log("١ · هل يرى الصفحات؟");
{
  const watched = orgs.flatMap((o) => o.sources.filter((s) => s.verifiedAtISO !== null));
  const everRead = new Set(
    health.filter((h) => h.lastSuccessISO !== null).map((h) => h.sourceUrl),
  );
  const readable = watched.filter((s) => everRead.has(s.url)).length;

  const blind = orgs.filter((o) => {
    const mine = o.sources.filter((s) => s.verifiedAtISO !== null);
    return mine.length === 0 || !mine.some((s) => everRead.has(s.url));
  });

  say(ok(`${readable} صفحة من ${watched.length} قُرئت فعلاً، عند ${orgs.length} جهة`));

  const blindSA = blind.filter((o) => o.tier === "S" || o.tier === "A");
  if (blind.length === 0) {
    say(ok("كل جهة لها مصدر واحد على الأقلّ يُقرأ"));
  } else {
    say(
      warnLine(
        `${blind.length} جهة لا يُقرأ منها شيء، منها ${blindSA.length} من الفئتين S وA` +
          (blindSA.length > 0 ? `: ${blindSA.map((o) => o.nameAr).slice(0, 6).join("، ")}` : ""),
      ),
    );
  }

  const last = health
    .map((h) => h.lastAttemptISO)
    .filter(Boolean)
    .sort()
    .at(-1);
  if (last === undefined) {
    say(bad("لم تعمل أي جولة قراءة بعد"));
  } else {
    const hours = (Date.now() - Date.parse(last)) / 3_600_000;
    const when = hours < 1 ? `${Math.round(hours * 60)} دقيقة` : `${hours.toFixed(1)} ساعة`;
    say(hours <= 3 ? ok(`آخر جولة قراءة قبل ${when}`) : bad(`آخر جولة قراءة قبل ${when}، والمفترض كل ربع ساعة`));
  }
}

/* ---------- ٢ · هل يحكم ---------- */

console.log("\n٢ · هل يحكم على ما يقرأ؟");
{
  const judged = opps.filter((o) => o.relevanceScore !== null).length;
  const pending = opps.filter((o) => o.flags.includes("needs_manual_review")).length;
  say(ok(`${judged} سجلاً عليه حكم، من ${opps.length}`));
  if (pending > 0) {
    say(
      warnLine(
        `${pending} سجلاً في طابور الحكم. هذا ينخفض من نفسه مع كل جولة، فإن بقي كما هو غداً فالتصنيف متوقّف.`,
      ),
    );
  }

  const bench = readOne<{ model: string; builtISO: string }>("data/benchmark.json");
  if (bench === null) {
    say(bad("لا يوجد مرجع مُختبَر"));
  } else {
    say(ok(`المرجع مبنيّ على ${bench.model}، بتاريخ ${bench.builtISO.slice(0, 10)}`));
  }

  const open = opps.filter((o) => o.status === "open" || o.status === "closing_soon");
  say(
    open.length > 0
      ? ok(`${open.length} نافذة مفتوحة الآن`)
      : ok("لا نافذة مفتوحة الآن، وهذا خبر لا عطب"),
  );
}

/* ---------- ٣ · هل يصل الجوّال ---------- */

console.log("\n٣ · هل يصل إلى جوّالك؟");
{
  if (notify === null) {
    say(warnLine("لم تعمل جولة إشعارات بعد، فلا رأي بعد"));
  } else if (notify.state === "down") {
    say(bad(`لا يصل شيء الآن. ${notify.reason}`));
    if (notify.heldCount > 0) {
      say(warnLine(`${notify.heldCount} إشعاراً محفوظ وينتظر، ولم يضِع منها شيء`));
    }
  } else if (notify.state === "untested" || notify.lastSuccessISO === null) {
    say(warnLine(notify.reason || "لم ينجح أي إرسال بعد، فلا دليل على أن جوّالك يستقبل"));
  } else {
    say(ok(`القناة تعمل، وآخر إرسال ناجح ${notify.lastSuccessISO.slice(0, 16).replace("T", " ")}`));
  }
}

/* ---------- ٤ · هل الموقع محدَّث ---------- */

console.log("\n٤ · هل الموقع الذي تشاركه محدَّث؟");
{
  try {
    const unpushed = execFileSync("git", ["log", "--oneline", "origin/master..HEAD"], {
      encoding: "utf8",
    }).trim();
    say(
      unpushed === ""
        ? ok("كل ما عندك منشور على الموقع")
        : warnLine(`${unpushed.split("\n").length} التزاماً لم يُرفع بعد، وسيُرفع في الجولة القادمة`),
    );
  } catch {
    say(warnLine("تعذّرت قراءة حالة git"));
  }

  const dirty = (() => {
    try {
      return execFileSync("git", ["status", "--porcelain", "--", "data"], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })();
  if (dirty !== "") {
    say(warnLine("بيانات جديدة على جهازك لم تُرفع بعد، وسترفعها الجولة القادمة"));
  }
}

/* ---------- ٥ · هل المراقب حيّ ---------- */

console.log("\n٥ · هل المراقب يعمل؟");
{
  if (process.platform !== "win32") {
    say(warnLine("هذا الفحص لويندوز وحده"));
  } else {
    try {
      const state = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-ScheduledTask -TaskName 'RASID v2 watcher' -ErrorAction SilentlyContinue).State",
        ],
        { encoding: "utf8", timeout: 30_000 },
      ).trim();
      say(
        state === "Running"
          ? ok("المراقب يعمل، ويقرأ ما يستحقّ القراءة كل ربع ساعة")
          : bad(`المراقب حالته ${state || "غير مثبّت"}. شغّله: Start-ScheduledTask -TaskName "RASID v2 watcher"`),
      );
    } catch {
      say(warnLine("تعذّرت قراءة حالة المهمة المجدولة"));
    }
  }
  if (existsSync("watch.log")) {
    const lines = readFileSync("watch.log", "utf8").trim().split("\n");
    const last = lines.at(-1) ?? "";
    console.log(`     آخر سطر في سجلّ المراقب: ${last.slice(0, 100)}`);
  }
}

console.log(
  `\n${problems === 0 ? "لا شيء مكسور في هذه اللحظة." : `${problems} شيئاً مكسوراً، وكلٌّ منها مكتوب أعلاه بما يجب عمله.`}`,
);
console.log("للفحص العميق: npm run gates\n");
process.exit(0);
