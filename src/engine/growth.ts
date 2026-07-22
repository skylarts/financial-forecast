import type { ISODate } from "@/domain";
import { elapsedYears } from "./dateMath";

/** Convert an annual rate to its equivalent monthly compounding rate. */
export function monthlyRateFromAnnual(annualRatePct: number): number {
  if (!annualRatePct) return 0;
  return Math.pow(1 + annualRatePct, 1 / 12) - 1;
}

/**
 * Grow a base amount for elapsed time at a NOMINAL annual rate. The entered
 * rate is the actual (nominal) growth -- it already includes inflation, so
 * e.g. a salary you expect to rise 4%/yr uses 0.04 directly. Displaying the
 * result in today's-dollars ("real") is a separate deflation step done at
 * render time via YearSnapshot.inflationDeflator, not here.
 */
export function growthAdjustedAmount(
  baseAmount: number,
  elapsedYears: number,
  nominalGrowthRatePct: number
): number {
  return baseAmount * Math.pow(1 + nominalGrowthRatePct, elapsedYears);
}

/**
 * Converts an amount entered in today's dollars (as of the plan start date)
 * into the nominal dollar amount at a given occurrence date. Growth happens
 * in two stages: from the plan start to the item's own start date, general
 * inflation erodes/inflates purchasing power (the item doesn't exist yet, so
 * there's no other rate to apply). From the item's start date onward, its own
 * configured rate takes over (a raise, COLA, etc.) which may differ from
 * inflation and defaults to flat-nominal (0) for ordinary income/expenses.
 *
 * When itemStartDate === planStartDate (the common case for baseline income
 * and expenses), the pre-start stage is a no-op and this reduces to the
 * original single-stage growth from the item's own start.
 */
export function todaysDollarsAmount(
  baseAmount: number,
  planStartDate: ISODate,
  itemStartDate: ISODate,
  occurrenceDate: ISODate,
  inflationRatePct: number,
  ownGrowthRatePct: number,
  stepOwnGrowthAnnually = false
): number {
  const nominalAtStart = growthAdjustedAmount(
    baseAmount,
    elapsedYears(planStartDate, itemStartDate),
    inflationRatePct
  );
  const sinceStart = elapsedYears(itemStartDate, occurrenceDate);
  // Stepped growth (Social Security COLA) applies once per CALENDAR year --
  // benefits adjust each January, not on the benefit's own start anniversary.
  const ownYears = stepOwnGrowthAnnually
    ? Math.max(0, Number(occurrenceDate.slice(0, 4)) - Number(itemStartDate.slice(0, 4)))
    : sinceStart;
  return growthAdjustedAmount(nominalAtStart, ownYears, ownGrowthRatePct);
}
