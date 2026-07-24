import type { ISODate } from "@/domain";

/** Add `months` calendar months, clamping the day to the target month's length. */
export function addMonths(date: ISODate, months: number): ISODate {
  const [y, m, d] = date.split("-").map(Number);
  const totalMonths = (m - 1) + months;
  const year = y + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12; // 0-indexed
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  const ms = Date.parse(date + "T00:00:00Z") + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function ageOn(birthDate: ISODate, onDate: ISODate): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [dy, dm, dd] = onDate.split("-").map(Number);
  let years = dy - by;
  if (dm < bm || (dm === bm && dd < bd)) years -= 1;
  return years;
}

/** Elapsed calendar years (fractional) between two ISO dates, using a 365.25-day year. */
export function elapsedYears(from: ISODate, to: ISODate): number {
  const fromMs = Date.parse(from + "T00:00:00Z");
  const toMs = Date.parse(to + "T00:00:00Z");
  return (toMs - fromMs) / (1000 * 60 * 60 * 24 * 365.25);
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
