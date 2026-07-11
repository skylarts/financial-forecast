import type { ISODate, RecurrenceFrequency } from "@/domain";
import { addMonths, compareDates } from "./dateMath";

/**
 * Expand a recurrence rule into concrete occurrence dates within
 * [startDate, min(endDate, horizonEnd)]. Ported from the daily-resolution
 * Python engine's RecurringItem.occurrences(), extended with 'one_time'.
 */
export function expandOccurrences(
  startDate: ISODate,
  endDate: ISODate | null,
  frequency: RecurrenceFrequency,
  horizonEnd: ISODate,
  /** When set (>0), recur every N years from startDate, ignoring `frequency`. */
  intervalYears?: number
): ISODate[] {
  const end = endDate && compareDates(endDate, horizonEnd) < 0 ? endDate : horizonEnd;
  if (compareDates(startDate, end) > 0) return [];

  const dates: ISODate[] = [];

  if (intervalYears && intervalYears > 0) {
    let i = 0;
    while (true) {
      const d = addMonths(startDate, i * intervalYears * 12);
      if (compareDates(d, end) > 0) break;
      dates.push(d);
      i += 1;
    }
    return dates;
  }

  if (frequency === "one_time") {
    dates.push(startDate);
    return dates;
  }

  if (frequency === "weekly" || frequency === "biweekly") {
    const stepDays = frequency === "weekly" ? 7 : 14;
    let cursor = startDate;
    while (compareDates(cursor, end) <= 0) {
      dates.push(cursor);
      const ms = Date.parse(cursor + "T00:00:00Z") + stepDays * 24 * 60 * 60 * 1000;
      cursor = new Date(ms).toISOString().slice(0, 10);
    }
    return dates;
  }

  const monthStep = frequency === "monthly" ? 1 : 12; // remaining case is 'annual'
  let i = 0;
  while (true) {
    const d = addMonths(startDate, i * monthStep);
    if (compareDates(d, end) > 0) break;
    dates.push(d);
    i += 1;
  }
  return dates;
}
