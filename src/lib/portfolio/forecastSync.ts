import type { Account } from "@/domain/account";
import type { Portfolio } from "@/domain/portfolio";
import { analyzePortfolio, type PriceMap } from "@/engine/portfolio/metrics";
import { hasSleeves } from "./accountTree";

export interface ForecastPush {
  forecastAccountId: string;
  startingBalance: number;
  /** Only present for a taxable target -- it's the only tax treatment the
   *  engine reads a cost basis for. */
  startingCostBasis?: number;
}

/**
 * Works out which linked forecast accounts are out of date with what the
 * portfolio tracker currently shows, so a caller can write just those and
 * skip everything already in sync.
 *
 * Four things keep a portfolio account from producing a push:
 *  - It is a split account's parent. Its sleeves each push their own half into
 *    their own forecast account, so pushing the parent as well would write the
 *    whole account's value a second time -- and into whichever single tax
 *    treatment the parent happened to be linked to, which is exactly the
 *    conflation the split exists to undo.
 *  - `syncToForecast` is off, or `forecastAccountId` doesn't resolve to a
 *    real account (a stale link left behind by a deleted forecast account).
 *  - The value hasn't actually changed -- compared post-rounding, the same
 *    guard the manual "Push to forecast" button uses, so this never writes
 *    a no-op patch that would just bump the plan's dirty flag for nothing.
 *  - Any position in the account is still unpriced. `analyzePortfolio` falls
 *    back to cost basis for a symbol with no quote, so pushing mid-load (or
 *    mid quote-feed hiccup) would write a wrong number into the plan --
 *    better to wait for a scope that's actually priced than sync a guess.
 */
export function pendingForecastPushes(
  portfolio: Portfolio,
  prices: PriceMap,
  forecastAccounts: readonly Account[],
): ForecastPush[] {
  const forecastById = new Map(forecastAccounts.map((a) => [a.id, a]));
  const pushes: ForecastPush[] = [];

  for (const account of portfolio.accounts) {
    if (hasSleeves(portfolio.accounts, account.id)) continue;
    if (!account.syncToForecast || !account.forecastAccountId) continue;
    const target = forecastById.get(account.forecastAccountId);
    if (!target) continue;

    const analysis = analyzePortfolio(portfolio, prices, { accountIds: [account.id] });
    const stillUnpriced = analysis.holdings.some((h) => h.kind === "position" && h.price === null);
    if (stillUnpriced) continue;

    const value = Math.round(analysis.summary.totalValue);
    const costBasis = Math.round(analysis.summary.costBasis);
    const balanceChanged = target.startingBalance !== value;
    const basisChanged =
      target.taxTreatment === "taxable" && target.startingCostBasis !== costBasis;
    if (!balanceChanged && !basisChanged) continue;

    pushes.push({
      forecastAccountId: target.id,
      startingBalance: value,
      ...(target.taxTreatment === "taxable" ? { startingCostBasis: costBasis } : {}),
    });
  }

  return pushes;
}
