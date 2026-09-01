/**
 * The one-word question, against real pages.
 *
 * This stage decides whether a page is worth paying to have judged properly,
 * and it is the only place in the pipeline where the model can make a page
 * disappear. So the test is asymmetric on purpose: **every real announcement
 * must survive it**, and a page that is genuinely about something else may or
 * may not — either answer there costs at most a cent.
 *
 * It runs the model for real, about ten times. That is the point: a triage
 * tested only against fixtures proves nothing about the thing that will
 * actually run. It used to cost a cent; now it costs about thirty seconds of
 * this machine's CPU and nothing else.
 *
 *   npm run test:triage
 */
import { triage } from "../src/pipeline/classify";
import { LOCAL_MODEL, localModelReady } from "../src/pipeline/model";

let failures = 0;
let noiseSkipped = 0;
const startedAt = Date.now();

async function ask(label: string, text: string, mustSurvive: boolean): Promise<void> {
  const r = await triage(text);
  const ok = mustSurvive ? r.looksLikeAnnouncement : true;
  if (!ok) failures++;
  if (!mustSurvive && !r.looksLikeAnnouncement) noiseSkipped++;
  console.log(
    `  ${ok ? "pass" : "FAIL"}  ${r.looksLikeAnnouncement ? "judge " : "skip  "} ${label}`,
  );
}

/*
 * A missing model fails this gate rather than skipping it.
 *
 * The pipeline is right to pass every page on when the model is unreachable -
 * that is the contract. But a *test* that treats an unreachable model as
 * success would report "no announcement was ruled out" about a run in which
 * nothing was asked, which is the same green light on an unlooked-at page that
 * this whole project exists to refuse.
 */
const ready = await localModelReady();
if (!ready.ok) {
  console.log(`the local model is not available, so nothing was tested: ${ready.reason}`);
  process.exit(1);
}
console.log(`model: ${ready.reason}\n`);

console.log("real announcements — every one must reach the full classifier\n");

await ask(
  "a plain co-op announcement",
  `تعلن الهيئة الوطنية للأمن السيبراني عن فتح باب التقديم في برنامج التدريب التعاوني
لطلاب وطالبات المرحلة الجامعية. التخصصات: الأمن السيبراني، علوم الحاسب.
آخر موعد للتقديم 12 ربيع الأول 1448.`,
  true,
);

await ask(
  "an announcement that never says co-op",
  `فرصة لطلاب الجامعات المتوقع تخرجهم للانضمام إلى فريق تقنية المعلومات لمدة فصل دراسي
كامل بمكافأة شهرية. يشترط أن يكون التدريب متطلب تخرج.`,
  true,
);

await ask(
  "a careers page listing several programmes",
  `الوظائف والتدريب — الصفحة الرئيسية
برنامج التدريب التعاوني · برنامج تطوير الخريجين · التدريب الصيفي · الوظائف الشاغرة
اطّلع على الفرص المتاحة وقدّم عبر البوابة.`,
  true,
);

await ask(
  "an English internship notice",
  `Summer Internship Programme 2026. We are accepting applications from
undergraduate students in computer science and cybersecurity for a twelve-week
placement in Riyadh. Applications close 15 September.`,
  true,
);

await ask(
  "a graduate-development programme, which must still be judged and scored zero",
  `برنامج تطوير الخريجين المنتهي بالتوظيف. يشترط أن يكون المتقدم قد تخرج فعلياً
وحاصلاً على وثيقة التخرج. المدة اثنا عشر شهراً.`,
  true,
);

await ask(
  "a thin page that merely mentions training in a menu",
  `الرئيسية · عن الجهة · الخدمات · التدريب · اتصل بنا
مرحباً بكم في الموقع الرسمي.`,
  true,
);

/*
 * The excerpt is a head slice plus the neighbourhood of the training word, so
 * an announcement at the bottom of a long news page must still survive. That is
 * the one thing a naive head slice would lose, and it is the shape a media
 * centre actually has: forty stories, and the co-op notice among them.
 */
await ask(
  "an announcement buried under 8,000 characters of unrelated news",
  `${"افتتح معالي الوزير المعرض السنوي بحضور عدد من المسؤولين وممثلي القطاع الخاص. ".repeat(100)}
تعلن الجهة عن فتح باب التقديم في برنامج التدريب التعاوني لطلاب الجامعات،
التخصصات المطلوبة: علوم الحاسب والأمن السيبراني.`,
  true,
);

console.log("\npages about something else — either answer is acceptable,");
console.log("but if none is skipped the filter is costing money and saving none\n");

await ask(
  "a press release about a meeting",
  `نائب أمير المنطقة يستقبل مدير الفرع لبحث سبل التعاون المشترك وتعزيز الشراكة
بين الجهتين في مجالات التنمية.`,
  false,
);

await ask(
  "quarterly financial results",
  `أعلن مجلس الإدارة عن النتائج المالية للربع الثالث من العام، بارتفاع الإيرادات
بنسبة أربعة بالمئة مقارنة بالفترة نفسها من العام الماضي.`,
  false,
);

await ask(
  "a service launch",
  `إطلاق الخدمة الإلكترونية الجديدة لإصدار التصاريح عبر المنصة الوطنية الموحدة،
ضمن جهود التحول الرقمي.`,
  false,
);

await ask(
  "an empty shell",
  `تحميل...`,
  false,
);

console.log(
  `\n${LOCAL_MODEL} on this machine's CPU: ${((Date.now() - startedAt) / 1000).toFixed(0)}s, $0.00`,
);
console.log(
  failures === 0
    ? "no real announcement was ruled out"
    : `${failures} REAL ANNOUNCEMENT(S) WERE RULED OUT — the filter is unsafe`,
);
console.log(
  noiseSkipped === 0
    ? "and nothing at all was skipped — the stage is pure cost, check the matcher"
    : `${noiseSkipped} of 4 unrelated pages were ruled out cheaply`,
);
// Safety is the hard requirement; saving nothing is a warning, not a failure.
process.exit(failures === 0 ? 0 : 1);
