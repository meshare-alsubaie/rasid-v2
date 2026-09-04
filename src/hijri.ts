/**
 * Reading a Saudi date, in code.
 *
 * Dates were the model's job, and they should not have been. An audit put a
 * real announcement in front of it and it returned the stipend correctly and
 * dropped the seat count, the duration and the city from the same sentence —
 * and a date is the one field where being approximately right is worthless. So
 * the model now reports the date *as the page wrote it*, and this file decides
 * what it means. Same input, same answer, every time, and a test can hold it.
 *
 * The conversion itself is not arithmetic. There are several Hijri calendars
 * and they disagree by a day or two; Saudi civil dates follow Umm al-Qura, and
 * `Intl` ships it as `islamic-umalqura` — the same table the printed calendar
 * comes from. Going Hijri → Gregorian is a search over that table rather than a
 * formula, which is slower and correct, and both of those matter more than
 * speed for four dates a day.
 *
 * The rule that governs everything here: when the year is not written, nothing
 * is guessed at. A wrong deadline is the one error this application must never
 * make.
 */

/** The window the search covers. 1400 AH is 1979; 1500 AH is 2076. */
const FIRST_YEAR = 1400;
const LAST_YEAR = 1500;
const DAY_MS = 86_400_000;

const umalqura = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  timeZone: "UTC",
});

/** The Umm al-Qura year, month and day for a Gregorian instant. */
export function hijriPartsOf(ms: number): { y: number; m: number; d: number } | null {
  try {
    const parts = umalqura.formatToParts(new Date(ms));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    const y = get("year");
    const m = get("month");
    const d = get("day");
    return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? { y, m, d } : null;
  } catch {
    return null;
  }
}

const rank = (y: number, m: number, d: number): number => y * 10_000 + m * 100 + d;

/**
 * The Gregorian day a Hijri date falls on, as `YYYY-MM-DD`, or null.
 *
 * A binary search over the ICU table. A Hijri year is about 354 days, so an
 * estimate is close enough to bound the search tightly, and the loop settles in
 * a handful of steps. Null when the date does not exist in the calendar at all
 * — the thirtieth of a twenty-nine-day month is a typo, not a deadline.
 */
export function hijriToISO(hy: number, hm: number, hd: number): string | null {
  if (hy < FIRST_YEAR || hy > LAST_YEAR) return null;
  if (hm < 1 || hm > 12 || hd < 1 || hd > 30) return null;

  const target = rank(hy, hm, hd);
  // 1 Muharram 1400 fell on 21 November 1979; from there a Hijri year averages
  // 354.367 days. The estimate only has to land within the search window.
  const estimate = Date.UTC(1979, 10, 21) + (hy - FIRST_YEAR) * 354.367 * DAY_MS;
  let lo = estimate - 400 * DAY_MS;
  let hi = estimate + 400 * DAY_MS;

  for (let step = 0; step < 64 && hi - lo > DAY_MS / 2; step++) {
    const mid = lo + Math.floor((hi - lo) / 2 / DAY_MS) * DAY_MS;
    const parts = hijriPartsOf(mid);
    if (!parts) return null;
    if (rank(parts.y, parts.m, parts.d) < target) lo = mid + DAY_MS;
    else hi = mid;
  }

  const found = hijriPartsOf(hi);
  if (!found || rank(found.y, found.m, found.d) !== target) return null;
  return new Date(hi).toISOString().slice(0, 10);
}

/**
 * Month names as Saudi pages actually write them.
 *
 * Both spellings of the fourth and sixth months are in use — ربيع الآخر and
 * ربيع الثاني name the same month — and a page picks one without warning.
 * Accepting only one of each pair would silently drop a sixth of all dates.
 */
/*
 * Each pattern consumes the *whole* month name, and that is not cosmetic.
 *
 * The first version stopped at the stem — "ربيع الآخ" out of "ربيع الآخر" — and
 * the leftover letter then sat between the month and the year, so the year was
 * never found and four of the twelve months silently produced no date at all.
 * They failed as "no year written", which is the one failure mode that looks
 * legitimate, so nothing about it was suspicious.
 *
 * The ordering matters too: the longer, more specific alternative comes first
 * in each pair, or ربيع الأول would swallow the beginning of ربيع الآخر.
 */
const MONTHS: [RegExp, number][] = [
  [/محرّ?م/, 1],
  [/صفر/, 2],
  [/ربيع\s*(?:ال)?(?:آخر|أخر|اخر|ثاني(?:ة)?)/, 4],
  [/ربيع\s*(?:ال)?(?:أول|اول|أوّل)/, 3],
  // The masculine spellings are here because pages use them: "جمادى الأول" and
  // "جمادى الآخر" are at least as common as the feminine forms, and every one
  // of them used to fall through the table and hand the date to the model.
  [/جمادى\s*(?:ال)?(?:آخرة|أخرة|اخرة|آخر|أخر|اخر|ثاني(?:ة)?)/, 6],
  [/جمادى\s*(?:ال)?(?:أولى|اولى|أُولى|أول|اول)/, 5],
  [/رجب/, 7],
  [/شعبان/, 8],
  [/رمضان/, 9],
  [/شوّ?ال/, 10],
  [/(?:ذو|ذي|ذا)\s*ال?قعدة/, 11],
  [/(?:ذو|ذي|ذا)\s*ال?حجّ?ة/, 12],
];

/**
 * Gregorian months, written in Arabic and in English.
 *
 * "15 سبتمبر 2026" is the shape the classifier's own system prompt uses as its
 * worked example, and this module could not read it: the reading failed, the
 * failure was reported as unambiguous, and the deadline fell through to the
 * model's own conversion — the one thing the whole file exists to avoid.
 *
 * The second-numbered alternatives come first where one name contains another,
 * the same ordering the Hijri table uses.
 */
const GREGORIAN_MONTHS: [RegExp, number][] = [
  [/يناير|january|jan\b/i, 1],
  [/فبراير|february|feb\b/i, 2],
  [/مارس|march|mar\b/i, 3],
  [/أبريل|ابريل|april|apr\b/i, 4],
  [/مايو|may\b/i, 5],
  [/يونيو|يونية|june|jun\b/i, 6],
  [/يوليو|يولية|july|jul\b/i, 7],
  [/أغسطس|اغسطس|august|aug\b/i, 8],
  [/سبتمبر|september|sep\b/i, 9],
  [/أكتوبر|اكتوبر|october|oct\b/i, 10],
  [/نوفمبر|november|nov\b/i, 11],
  [/ديسمبر|december|dec\b/i, 12],
];

/**
 * The day, immediately before a month name.
 *
 * The old pattern allowed whitespace and nothing else between the digits and
 * the month, so a definite article or the word "شهر" left over on the left was
 * enough to lose the date: "1 المحرم 1448" and "12 من شهر ربيع الأول 1448" both
 * read as no date at all. That is the same leftover-letter problem the month
 * patterns were already written to survive on the right.
 */
/*
 * A hyphen or a slash is a separator too.
 *
 * The pattern allowed whitespace and Arabic words and nothing else, so
 * `06-May-2026` and `14-Sep-2023` - which are what an English-language Saudi
 * careers portal actually prints - were read as no date at all. Both were
 * sitting in the live verdict memory, copied correctly off the page by the
 * model, and thrown away here.
 */
const DAY_BEFORE = /(\d{1,2})\s*[-/.]?\s*(?:من\s+)?(?:شهر\s+)?(?:ال)?\s*$/;

/** "غرة رمضان" is the first of the month, and this file documented it as read. */
const FIRST_OF_MONTH = /(?:غرّة|غرة|أوّل|أول|اول)\s*(?:من\s+)?(?:شهر\s+)?(?:ال)?\s*$/;

/** ٠١٢٣٤٥٦٧٨٩ and ۰۱۲۳۴۵۶۷۸۹ are digits too. */
function westernDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) =>
    String(((c.codePointAt(0)! - 0x0660) % 16).toString(10).slice(-1)),
  );
}

export interface ParsedDate {
  /** The Gregorian day, or null when it could not be determined. */
  iso: string | null;
  /** "hijri" | "gregorian" — what the page was writing. */
  calendar: "hijri" | "gregorian" | null;
  /** True when a day and month were read but no year was written. */
  ambiguousYear: boolean;
  /**
   * True when `12/03/2026` could as honestly be March or December.
   *
   * The reading is day-first, and that is right: it is the Saudi convention and
   * the convention of every page this project reads. But a site running an
   * imported CMS, or an English page written for an international audience,
   * writes the same eleven characters meaning the other month — and the reading
   * was silently wrong by up to eleven months with nothing to show for it.
   *
   * Both fields have to be twelve or less, and they have to differ: `25/03` has
   * only one reading, and `03/03` has only one answer. What is left is a real
   * fork, and it is said out loud rather than guessed at quietly.
   */
  ambiguousOrder?: boolean;
  /** What was matched, so a reader can check the reading. */
  matched: string | null;
}

const NONE: ParsedDate = { iso: null, calendar: null, ambiguousYear: false, matched: null };

/**
 * Read one date out of a phrase, as the page wrote it.
 *
 * Handles the shapes these announcements actually use: `12 ربيع الأول 1448`,
 * `١٤٤٨/٣/١٢`, `1448-03-12`, `12/03/2026`, `2026-09-15`, and a named Hijri month
 * with no year at all.
 *
 * A year that is not written is not invented. It would be easy to assume "the
 * next occurrence", and it would be wrong the first time a page republished an
 * old announcement — so the day and month are reported with `ambiguousYear` and
 * no ISO date, and the deadline alarm stays quiet rather than firing on a guess.
 */
export function parseArabicDate(input: string): ParsedDate {
  return pickDate(input, "first");
}

/**
 * The same reading, when the string may hold a *range*.
 *
 * "من 1 رجب 1448 إلى 15 شعبان 1448" is how Saudi pages write an application
 * window, and it is the single most likely thing for a model to copy into one
 * field. Read as a single date it gave the wrong answer twice over: the old
 * loop walked the month table in calendar order and returned whichever month
 * came first in the *year*, not in the *text*, so a window that opened in Rajab
 * and closed in Sha'ban reported the opening date as the deadline — forty-four
 * days early, with `ambiguousYear` false, so nothing refused it. Written with
 * plain ISO dates it was worse: "من 2026-09-01 إلى 2026-12-30" stored the first
 * one, and the record was `closed` on the day it appeared.
 *
 * So the caller says which end of the range it is asking about. A field holding
 * one date gets the same answer either way.
 */
export function parseArabicDateRange(input: string, end: "first" | "last"): ParsedDate {
  return pickDate(input, end);
}

interface Sighting {
  index: number;
  parsed: ParsedDate;
}

/** Every date in the string, in the order the string writes them. */
function allDates(text: string): Sighting[] {
  const out: Sighting[] = [];

  const named = (
    table: [RegExp, number][],
    calendar: "hijri" | "gregorian",
  ): void => {
    for (const [re, month] of table) {
      const scan = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      let at: RegExpExecArray | null;
      while ((at = scan.exec(text)) !== null) {
        const before = text.slice(Math.max(0, at.index - 16), at.index);
        const after = text.slice(at.index + at[0].length, at.index + at[0].length + 14);
        const day = DAY_BEFORE.exec(before)?.[1] ?? (FIRST_OF_MONTH.test(before) ? "1" : undefined);
        if (day === undefined) continue;
        // "هـ", "ه", "من عام", a comma — a few Arabic letters may stand between
        // the month and its year without meaning the year is absent.
        // `-` and `/` for the `06-May-2026` shape; see DAY_BEFORE.
        const year = /^[\s\p{L}ـ.،,\-/]{0,10}?(\d{4})/u.exec(after)?.[1];

        if (calendar === "gregorian") {
          if (year === undefined || !/^(19|20|21)\d\d$/.test(year)) {
            out.push({
              index: at.index,
              parsed: { iso: null, calendar: "gregorian", ambiguousYear: true, matched: `${day} ${at[0]}` },
            });
            continue;
          }
          const iso = `${year}-${String(month).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
          const ok = !Number.isNaN(Date.parse(iso)) && new Date(iso).getUTCDate() === Number(day);
          out.push({
            index: at.index,
            parsed: {
              iso: ok ? iso : null,
              calendar: "gregorian",
              ambiguousYear: false,
              matched: `${day} ${at[0]} ${year}`,
            },
          });
          continue;
        }

        // Hijri years are four digits starting 14; anything else beside an
        // Arabic month name is a Gregorian year written in an Arabic sentence.
        if (year !== undefined && /^1[34]\d\d$/.test(year)) {
          out.push({
            index: at.index,
            parsed: {
              iso: hijriToISO(Number(year), month, Number(day)),
              calendar: "hijri",
              ambiguousYear: false,
              matched: `${day} ${at[0]} ${year}`,
            },
          });
        } else {
          out.push({
            index: at.index,
            parsed: { iso: null, calendar: "hijri", ambiguousYear: true, matched: `${day} ${at[0]}` },
          });
        }
      }
    }
  };

  named(MONTHS, "hijri");
  named(GREGORIAN_MONTHS, "gregorian");

  /* Numeric, in either calendar: 1448/03/12, 1448-03-12, 12/03/1448. */
  const numeric = /(\d{2,4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,4})/g;
  let n: RegExpExecArray | null;
  while ((n = numeric.exec(text)) !== null) {
    const [, a, b, c] = n as unknown as [string, string, string, string];
    const first = Number(a);
    const last = Number(c);
    // Year first when the first field is four digits, else year last.
    const [y, m, d] = a.length === 4 ? [first, Number(b), last] : [last, Number(b), first];

    if (y >= FIRST_YEAR && y <= LAST_YEAR) {
      out.push({
        index: n.index,
        parsed: { iso: hijriToISO(y, m, d), calendar: "hijri", ambiguousYear: false, matched: n[0] },
      });
    } else if (y >= 1900 && y <= 2200) {
      const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const ok = !Number.isNaN(Date.parse(iso)) && new Date(iso).getUTCDate() === d;
      // Year last, and both of the other two could be a month: see ambiguousOrder.
      const forked = a.length !== 4 && d <= 12 && m <= 12 && d !== m;
      out.push({
        index: n.index,
        parsed: {
          iso: ok ? iso : null,
          calendar: "gregorian",
          ambiguousYear: false,
          ambiguousOrder: forked,
          matched: n[0],
        },
      });
    } else {
      out.push({ index: n.index, parsed: { ...NONE, matched: n[0] } });
    }
  }

  /*
   * Sorted by where the string writes them, which is the whole point. Ties go
   * to the longer reading: a named month and a bare numeric run can start at
   * the same offset, and the named one carries more of the page's own words.
   */
  return out.sort(
    (x, y) => x.index - y.index || (y.parsed.matched?.length ?? 0) - (x.parsed.matched?.length ?? 0),
  );
}

function pickDate(input: string, end: "first" | "last"): ParsedDate {
  if (typeof input !== "string" || input.trim() === "") return NONE;
  /*
   * Direction and zero-width marks are stripped before anything is matched.
   * gov.sa markup is full of them, and one sitting between a digit and a month
   * name is enough to break the adjacency every rule here depends on. Only the
   * two most common were removed before; U+061C and the isolate marks were not.
   */
  const text = westernDigits(input).replace(/[​-‏؜⁦-⁩﻿]/g, "");

  const seen = allDates(text);
  if (seen.length > 0) {
    /*
     * A reading with a real date beats one without: a range written as
     * "من 12 ربيع الأول إلى 15 شعبان 1448" has a year only on the second date,
     * and reporting the deadline as unreadable because the *opening* date was
     * ambiguous would throw away the one date the page did state fully.
     */
    const ordered = end === "last" ? [...seen].reverse() : seen;
    return (ordered.find((s) => s.parsed.iso !== null) ?? ordered[0]!).parsed;
  }

  /* A bare ISO date the classifier already resolved. */
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    return { iso: iso[0], calendar: "gregorian", ambiguousYear: false, matched: iso[0] };
  }

  return NONE;
}
