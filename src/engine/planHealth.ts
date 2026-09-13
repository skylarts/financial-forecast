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

/** "End of plan" or "Runs short in 2063". */
export function holdsThroughLabel(result: Pick<ProjectionResult, "warnings">): string {
  const year = firstShortfallYear(result);
  return year === null ? "End of plan" : `Runs short in ${year}`;
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
