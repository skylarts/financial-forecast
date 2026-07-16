import type { Account, Id } from "@/domain";

/**
 * Where a single-destination posting (mortgage payments, contribution draws,
 * RMD landing spot) goes: the mandatory Extra Savings account (see
 * scenarioSchema's auto-inject transform), else the first cash-class account
 * (defensive fallback -- Extra Savings should always exist on any parsed
 * scenario, but a hand-built Scenario object in a test might skip parsing).
 */
export function resolvePrimarySpendingAccountId(accounts: Account[]): Id | null {
  const extraSavings = accounts.find((a) => a.isExtraSavings);
  if (extraSavings) return extraSavings.id;
  const cash = accounts.find((a) => a.class === "cash");
  return cash ? cash.id : null;
}
