"use client";

import { useEffect, useRef } from "react";
import type { Portfolio } from "@/domain/portfolio";
import type { PriceMap } from "@/engine/portfolio/metrics";
import { pendingForecastPushes } from "@/lib/portfolio/forecastSync";
import { usePlanStore } from "@/store/usePlanStore";
import { usePortfolioStore } from "@/store/usePortfolioStore";

const SYNC_DEBOUNCE_MS = 1500;

/**
 * Keeps a linked forecast account's starting balance (and, for a taxable
 * account, its cost basis) matched to what the portfolio tracker currently
 * shows, without a button press.
 *
 * Debounced the same way the two cloud-sync hooks are, so a burst of
 * mutations -- an import, several quote refreshes landing close together --
 * settles into one write per affected account rather than one per change.
 * Self-terminating: applying a push changes the forecast account, which
 * re-fires this effect, but the next computation sees the balance already
 * matches and produces nothing further to push.
 *
 * Gated on `cloudSyncReady` (from `useCloudSync`, mounted alongside this):
 * without it, a browser that hasn't pulled its cloud plan yet would compute
 * pushes against the still-default local plan and write a real portfolio
 * value into an account the user hasn't actually loaded.
 */
export function useForecastValueSync(
  portfolio: Portfolio,
  prices: PriceMap,
  cloudSyncReady: boolean,
  onApplied?: (count: number) => void,
): void {
  const portfolioHasHydrated = usePortfolioStore((s) => s.hasHydrated);
  const planHasHydrated = usePlanStore((s) => s.hasHydrated);
  const forecastAccounts = usePlanStore((s) => s.activeScenario().accounts);
  const updateAccount = usePlanStore((s) => s.updateAccount);
  const onAppliedRef = useRef(onApplied);
  useEffect(() => {
    onAppliedRef.current = onApplied;
  }, [onApplied]);

  useEffect(() => {
    if (!portfolioHasHydrated || !planHasHydrated || !cloudSyncReady) return;

    const timer = setTimeout(() => {
      const pushes = pendingForecastPushes(portfolio, prices, forecastAccounts);
      if (pushes.length === 0) return;

      for (const push of pushes) {
        const target = forecastAccounts.find((a) => a.id === push.forecastAccountId);
        if (!target) continue;
        updateAccount(target.id, {
          ...target,
          startingBalance: push.startingBalance,
          ...(push.startingCostBasis !== undefined
            ? { startingCostBasis: push.startingCostBasis }
            : {}),
        });
      }
      onAppliedRef.current?.(pushes.length);
    }, SYNC_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [portfolio, prices, forecastAccounts, portfolioHasHydrated, planHasHydrated, cloudSyncReady, updateAccount]);
}
