import type { ISODate } from "@/domain";

/** Today's date, 'YYYY-MM-DD' -- the resolved value of a null plan start
 *  date (see forecastSettingsSchema.startDate) or any other "left blank
 *  means now" field. */
export function todayISO(): ISODate {
  return new Date().toISOString().slice(0, 10);
}

/*
 * The three functions below (addMonths, ageOn, elapsedYears) are the engine's
 * hot path: a 60-year projection calls them a few hundred thousand times, and
 * before they were written this way -- `split("-").map(Number)` plus a `new
 * Date(...)` per call -- they were a third of every projection's run time.
 * That mattered once the stress tests started running the engine hundreds of
 * times per keystroke. Every date here is a validated 'YYYY-MM-DD', so the
 * digits are read straight out of the string and month lengths come from a
 * table rather than from Date.
 */

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a 1-indexed month. */
function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

/** The four-digit year of a 'YYYY-MM-DD' string, read without allocating. */
function isoYear(date: string): number {
  return (date.charCodeAt(0) - 48) * 1000 + (date.charCodeAt(1) - 48) * 100 + (date.charCodeAt(2) - 48) * 10 + (date.charCodeAt(3) - 48);
}
function isoMonth(date: string): number {
  return (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
}
function isoDay(date: string): number {
  return (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
}

const TWO_DIGITS = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, "0"));

function formatISO(year: number, month: number, day: number): ISODate {
  return `${year}-${TWO_DIGITS[month]}-${TWO_DIGITS[day]}`;
}

/**
 * Days since 1970-01-01 for a civil date (proleptic Gregorian) -- the same
 * number Date.parse(date + "T00:00:00Z") / 86_400_000 gives, without the
 * parse. Howard Hinnant's days_from_civil.
 */
function dayNumber(date: string): number {
  const y0 = isoYear(date);
  const m = isoMonth(date);
  const d = isoDay(date);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Add `months` calendar months, clamping the day to the target month's length. */
export function addMonths(date: ISODate, months: number): ISODate {
  const totalMonths = isoMonth(date) - 1 + months;
  const year = isoYear(date) + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12 + 1;
  const d = isoDay(date);
  const day = d > 28 ? Math.min(d, daysInMonth(year, month)) : d;
  return formatISO(year, month, day);
}

export function addDays(date: ISODate, days: number): ISODate {
  const ms = Date.parse(date + "T00:00:00Z") + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function ageOn(birthDate: ISODate, onDate: ISODate): number {
  const bm = isoMonth(birthDate);
  const dm = isoMonth(onDate);
  let years = isoYear(onDate) - isoYear(birthDate);
  if (dm < bm || (dm === bm && isoDay(onDate) < isoDay(birthDate))) years -= 1;
  return years;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Elapsed calendar years (fractional) between two ISO dates, using a 365.25-day year. */
export function elapsedYears(from: ISODate, to: ISODate): number {
  // Written as a millisecond difference over a millisecond year so the
  // result is bit-for-bit what the Date.parse version produced -- growth
  // factors feed Math.pow, and a last-digit change would ripple.
  return ((dayNumber(to) - dayNumber(from)) * MS_PER_DAY) / (MS_PER_DAY * 365.25);
}

/** The date a person born on `birthDate` turns `age` (fractional ages round to the nearest month). */
export function birthdayAtAge(birthDate: ISODate, age: number): ISODate {
  return addMonths(birthDate, Math.round(age * 12));
}

export function yearOf(date: ISODate): number {
  return Number(date.slice(0, 4));
}

export function yearMonthOf(date: ISODate): string {
  return date.slice(0, 7); // 'YYYY-MM'
}

export function endOfYear(year: number): ISODate {
  return `${year}-12-31`;
}

/** Last day of the 'YYYY-MM' month (handles 28/29/30/31-day months). */
export function endOfMonth(yearMonth: string): ISODate {
  return `${yearMonth.slice(0, 7)}-${TWO_DIGITS[daysInMonth(isoYear(yearMonth), isoMonth(yearMonth))]}`;
}

/**
 * The 15th of the 'YYYY-MM' month -- the mid-period date a month's FLOWS
 * deflate to, mirroring how annual flows deflate to July 1 rather than
 * Dec 31 (flows land throughout the period, so on average at its midpoint).
 */
export function midMonth(yearMonth: string): ISODate {
  return `${yearMonth}-15`;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact column header for a 'YYYY-MM' month: "Mar '26". */
export function monthColumnLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split("-");
  return `${MONTH_ABBR[Number(m) - 1]} '${y.slice(2)}`;
}

export function startOfYear(year: number): ISODate {
  return `${year}-01-01`;
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Iterate the 1st of every month from `start` to `end` inclusive (both truncated to month boundaries). */
export function* eachMonthStart(start: ISODate, end: ISODate): Generator<ISODate> {
  let cursor = `${start.slice(0, 7)}-01`;
  const endMonth = `${end.slice(0, 7)}-01`;
  while (compareDates(cursor, endMonth) <= 0) {
    yield cursor;
    cursor = addMonths(cursor, 1);
  }
}

/** Whole months from one 'YYYY-MM' (or ISO date) to another; negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  return (ty - fy) * 12 + (tm - fm);
}
