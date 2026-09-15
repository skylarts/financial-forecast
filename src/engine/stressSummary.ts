import type { Account, ProjectionResult } from "@/domain";
import { firstImprovisedYear, firstShortfallYear } from "./planHealth";

/**
 * The slice of a projection the stress tests read: net worth by year, where
 * and how badly the plan runs short, and the year-end figures the tab's
 * columns need. A full ProjectionResult carries a monthly ledger of a few
 * thousand rows; a stress suite runs the engine hundreds of times in a
 * worker and posts each answer back, so it posts this instead.
 */
export interface StressYear {
  year: number;
  netWorthNominal: number;
  netWorthReal: number;
  /** What the household could spend from at year end (cash, investments, HSA), nominal. */
  investableNominal: number;
  /** That year's expenses plus tax, nominal. */
  spendNominal: number;
}

export interface StressSummary {
  years: StressYear[];
  endYear: number;
  netWorthAtEnd: number;
  netWorthAtEndReal: number;
  /** The first year the household could not cover its spending, or null when the plan holds. */
  firstShortfallYear: number | null;
  /**
   * The first year the drain order could not reach money that existed, so an
   * account outside it was raided. The plan held; the routing did not. Null
   * when the plan was followed as written.
   */
  firstImprovisedYear: number | null;
  /**
   * How far below zero the household's cash is driven, at its worst year
   * end -- the size of the hole, not just the year it opens. 0 when the
   * plan holds. Positive numbers.
   */
  shortfallDepthNominal: number;
  shortfallDepthReal: number;
  /** The plan's low point in today's dollars, and when. */
  lowestReal: { year: number; value: number };
}

/** Account classes a household can actually spend from (a home is not spending money). */
const INVESTABLE = new Set<Account["class"]>(["cash", "taxable_investment", "tax_deferred", "tax_free", "hsa"]);

export function summarizeProjection(result: ProjectionResult): StressSummary {
  const investable = result.accounts.filter((a) => a.category === "asset" && !a.isExcluded && INVESTABLE.has(a.class)).map((a) => a.id);
  const shortAccounts = new Set(result.warnings.filter((w) => w.kind === "insufficient_funds" && w.accountId).map((w) => w.accountId as string));
  let shortfallDepthNominal = 0;
  let shortfallDepthReal = 0;
  let lowestReal = { year: 0, value: Number.POSITIVE_INFINITY };
  const years: StressYear[] = result.years.map((y) => {
    for (const id of shortAccounts) {
      const balance = y.accountBalances[id] ?? 0;
      if (balance < -shortfallDepthNominal) {
        shortfallDepthNominal = -balance;
        shortfallDepthReal = -balance / y.inflationDeflator;
      }
    }
    if (y.netWorthReal < lowestReal.value) lowestReal = { year: y.year, value: y.netWorthReal };
    return {
      year: y.year,
      netWorthNominal: y.netWorthNominal,
      netWorthReal: y.netWorthReal,
      investableNominal: investable.reduce((s, id) => s + (y.accountBalances[id] ?? 0), 0),
      spendNominal: y.cashFlow.totalExpenses + y.cashFlow.federalTaxTotal,
    };
  });
  return {
    years,
    endYear: years[years.length - 1]?.year ?? 0,
    netWorthAtEnd: result.kpis.netWorthAtEnd,
    netWorthAtEndReal: result.kpis.netWorthAtEndReal,
    firstShortfallYear: firstShortfallYear(result),
    firstImprovisedYear: firstImprovisedYear(result),
    shortfallDepthNominal,
    shortfallDepthReal,
    lowestReal: Number.isFinite(lowestReal.value) ? lowestReal : { year: 0, value: 0 },
  };
}

/** Net worth in a given year, or null when the run does not reach it. */
export function netWorthIn(summary: StressSummary, year: number | null, real: boolean): number | null {
  if (year === null) return null;
  const y = summary.years.find((s) => s.year === year);
  return y ? (real ? y.netWorthReal : y.netWorthNominal) : null;
}

/** How many years of that year's spending the investable accounts would cover at its end; null when nothing was spent. */
export function yearsOfSpendingCovered(summary: StressSummary, year: number): number | null {
  const y = summary.years.find((s) => s.year === year);
  if (!y || y.spendNominal <= 0) return null;
  return y.investableNominal / y.spendNominal;
}
