import type { Account, ProjectionResult } from "@/domain";

/**
 * Plain-language readings of a projection: does the plan hold, and for how
 * long. Shared by the Overview tiles and the stress test.
 */

/** The first year the household could not cover its spending, or null when it never happens. */
export function firstShortfallYear(result: Pick<ProjectionResult, "warnings">): number | null {
  let first: number | null = null;
  for (const w of result.warnings) {
    if (w.kind !== "insufficient_funds") continue;
    if (first === null || w.year < first) first = w.year;
  }
  return first;
}

/**
 * The first year the withdrawal routing could not reach money that existed,
 * so the engine had to raid an account outside the plan. Null when the plan
 * was followed as written. This is the softer of the two signals: the
 * household kept paying its bills, but not the way it meant to.
 */
export function firstImprovisedYear(result: Pick<ProjectionResult, "warnings">): number | null {
  let first: number | null = null;
  for (const w of result.warnings) {
    if (w.kind !== "unplanned_withdrawal") continue;
    if (first === null || w.year < first) first = w.year;
  }
  return first;
}

/** "End of plan", "Improvises from 2049" or "Runs short in 2063". */
export function holdsThroughLabel(result: Pick<ProjectionResult, "warnings">): string {
  const year = firstShortfallYear(result);
  if (year !== null) return `Runs short in ${year}`;
  const improvised = firstImprovisedYear(result);
  return improvised === null ? "End of plan" : `Improvises from ${improvised}`;
}

/** Account classes a household can actually spend from (a home is not spending money). */
const INVESTABLE = new Set<Account["class"]>(["cash", "taxable_investment", "tax_deferred", "tax_free", "hsa"]);

/**
 * How many years of that year's spending (expenses plus tax) the household's
 * investable accounts would cover at the end of `year`. Null when the year is
 * not in the plan or nothing was spent.
 */
export function spendingCoveredYears(result: Pick<ProjectionResult, "years" | "accounts">, year: number): number | null {
  const y = result.years.find((s) => s.year === year);
  if (!y) return null;
  const spend = y.cashFlow.totalExpenses + y.cashFlow.federalTaxTotal;
  if (spend <= 0) return null;
  const investable = result.accounts
    .filter((a) => a.category === "asset" && !a.isExcluded && INVESTABLE.has(a.class))
    .reduce((s, a) => s + (y.accountBalances[a.id] ?? 0), 0);
  return investable / spend;
}
