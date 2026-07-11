import type { Account, Id, MoneyFlow } from "@/domain";

/**
 * Where a single-destination posting (mortgage payments, contribution draws,
 * RMD landing spot) goes: the first configured hub that still exists among
 * these accounts, else the first cash-class account (legacy fallback for a
 * scenario with no hub configured yet).
 */
export function resolvePrimarySpendingAccountId(accounts: Account[], moneyFlow: MoneyFlow): Id | null {
  const accountIds = new Set(accounts.map((a) => a.id));
  const firstHub = moneyFlow.hubs.find((h) => accountIds.has(h.accountId));
  if (firstHub) return firstHub.accountId;
  const cash = accounts.find((a) => a.class === "cash");
  return cash ? cash.id : null;
}
