/**
 * Every English word the interface would otherwise show, translated once.
 *
 * The dataset is written in the vocabulary of the code — `semi_gov`, `HTTP 403`,
 * `browserType.launch` — and the interface used to print those verbatim to an
 * Arabic reader. An audit counted fifty-six English lines in the health panel
 * alone, nine untranslated sector names in a filter the reader is meant to
 * choose from, and Latin organisation ids in the banner at the top of the
 * screen. None of it is a translation problem in the ordinary sense; it is code
 * vocabulary leaking through a seam nobody looked at.
 *
 * Kept in its own module, free of the DOM and of Vite, so a gate can run every
 * value the live dataset holds through these functions and assert that nothing
 * Latin comes out the other side.
 */

/** The sectors the dataset uses, in the reader's language. */
const SECTORS: Record<string, string> = {
  gov: "حكومي",
  semi_gov: "شبه حكومي",
  bank: "بنوك",
  finance: "مالية",
  tech: "تقنية",
  consulting: "استشارات",
  health: "صحّي",
  industrial: "صناعي",
  startup: "شركات ناشئة",
};

/** Unknown values are shown as they are rather than hidden: a gap must be visible. */
export const sectorLabel = (sector: string): string => SECTORS[sector] ?? sector;

/** Every sector the dataset can hold, for a gate to check against. */
export const KNOWN_SECTORS = Object.keys(SECTORS);

/**
 * What went wrong with a source, said to the person looking at it.
 *
 * These strings arrive from libraries and are stored verbatim, so the health
 * panel was printing Node error prose at an Arabic reader, and eighteen of those
 * lines named the owner's own hard drive. The paths are stripped where the error
 * is written now; this is the other half.
 *
 * Anything unrecognised gets a plain Arabic sentence rather than the raw text.
 * Passing an untranslated string through would be exactly the failure this
 * replaces, and "we could not read the page" is true of every one of them.
 */
export function humanError(raw: string): string {
  /*
   * Already ours, already Arabic. Judged by which script the sentence is mostly
   * written in rather than by whether any Latin appears at all: our own message
   * about a soft 404 quotes the page's title, and a page titled "Error" should
   * not send an Arabic sentence to the generic fallback.
   */
  const arabic = (raw.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (raw.match(/[A-Za-z]/g) ?? []).length;
  if (arabic > latin) return raw;

  if (/chromium unavailable|playwright/i.test(raw)) {
    return "هذه الصفحة تحتاج متصفّحاً كاملاً لقراءتها، ولم يكن متاحاً وقت الجولة.";
  }
  if (/robots\.txt/i.test(raw)) {
    if (/timeout|aborted/i.test(raw)) return "لم يردّ الموقع على ملفّ الصلاحيات في الوقت المسموح.";
    return "تعذّر الوصول إلى ملفّ صلاحيات الموقع، والغالب أنها مشكلة اتّصال من عندنا لا من الموقع.";
  }
  if (/disallow/i.test(raw)) return "الموقع يمنع القراءة الآلية لهذه الصفحة، فهي غير مراقَبة.";

  const http = /HTTP\s*(\d{3})/i.exec(raw);
  if (http) {
    const code = Number(http[1]);
    if (code === 403) return "الموقع رفض الطلب (٤٠٣)، وغالباً يحجب القراءة الآلية.";
    if (code === 404) return "الصفحة لم تعد موجودة (٤٠٤).";
    if (code === 410) return "الصفحة أُزيلت نهائياً (٤١٠).";
    if (code >= 500) return "الموقع نفسه يعطي خطأً في خادمه.";
    return "الموقع ردّ برمز لا يعني نجاحاً.";
  }
  if (/timeout|aborted|ETIMEDOUT/i.test(raw)) return "انتهى وقت الانتظار قبل أن يردّ الموقع.";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return "لم يُعثر على عنوان الموقع، وقد يكون النطاق تغيّر.";
  }
  if (/ECONNREFUSED/i.test(raw)) return "الموقع رفض الاتّصال.";
  if (/certificate|SSL|TLS/i.test(raw)) return "شهادة الأمان للموقع غير سليمة، فلم تُفتح الصفحة.";
  if (/fetch failed|ECONNRESET|socket|network/i.test(raw)) return "انقطع الاتّصال أثناء القراءة.";
  return "تعذّرت قراءة هذه الصفحة في آخر جولة.";
}
