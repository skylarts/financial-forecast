import { nanoid } from "nanoid";
import type { Account, DrainStop, Id, WithdrawalStrategy } from "@/domain";
import { treatmentOf } from "./resolveEvents";

/**
 * Withdrawal strategy presets: which accounts cover a shortfall, in what
 * order, derived from the account list itself so nothing is ever left out.
 * "custom" is the hand-built drain order from the Routing tab.
 */

export type DrainTier = "cash" | "taxable" | "tax_deferred" | "tax_free";

export const STRATEGY_LABELS: Record<WithdrawalStrategy, string> = {
  conventional: "Taxable first, Roth last",
  tax_deferred_first: "Tax-deferred first",
  pro_rata: "A bit of everything",
  custom: "Custom order",
};

export const STRATEGY_DESCRIPTIONS: Record<WithdrawalStrategy, string> = {
  conventional:
    "Spend cash and taxable accounts first, then tax-deferred accounts, and leave Roth money to grow tax-free for last. The usual advice.",
  tax_deferred_first:
    "Spend cash first, then draw tax-deferred accounts while your tax bracket is low (before Social Security and required distributions push it up), then taxable, then Roth.",
  pro_rata: "Spend cash first, then take from every investment account in proportion to its balance, so each shrinks at the same pace.",
  custom: "Exactly the order and rules set below.",
};

export const TIER_LABELS: Record<DrainTier, string> = {
  cash: "Cash",
  taxable: "Taxable",
  tax_deferred: "Tax-deferred",
  tax_free: "Roth",
};

/** The tier an account drains in, or null when the presets never touch it (a home, a 529, an HSA, a liability, the hub). */
export function drainTierOf(account: Account): DrainTier | null {
  if (account.category !== "asset" || account.isExcluded || account.isExtraSavings) return null;
  if (account.class === "real_estate" || account.class === "other_asset" || account.class === "education_529" || account.class === "hsa") return null;
  if (account.class === "cash") return "cash";
  const t = treatmentOf(account);
  if (t === "taxable") return "taxable";
  if (t === "tax_deferred") return "tax_deferred";
  if (t === "tax_free") return "tax_free";
  return null;
}

/** The order of tiers a preset drains in. */
export function strategyTiers(strategy: Exclude<WithdrawalStrategy, "custom">): DrainTier[] {
  switch (strategy) {
    case "conventional":
      return ["cash", "taxable", "tax_deferred", "tax_free"];
    case "tax_deferred_first":
      return ["cash", "tax_deferred", "taxable", "tax_free"];
    case "pro_rata":
      return ["cash", "taxable", "tax_deferred", "tax_free"];
  }
}

/** Accounts a preset would draw from, in the order it draws them. */
export function accountsInStrategyOrder(strategy: Exclude<WithdrawalStrategy, "custom">, accounts: Account[]): Account[] {
  const tiers = strategyTiers(strategy);
  const out: Account[] = [];
  for (const tier of tiers) {
    for (const a of accounts) if (drainTierOf(a) === tier) out.push(a);
  }
  return out;
}

function fullStop(accountId: Id, id: Id): DrainStop {
  return {
    id,
    accountId,
    kind: "percent_of_remainder",
    amount: null,
    pct: 1,
    startDate: null,
    endDate: null,
    minBalance: null,
    minBalanceGrowthRatePct: null,
  };
}

/**
 * The drain order a preset stands for, as concrete stops. For pro_rata the
 * investment stops carry pct 1 here; the engine reweights them each month by
 * balance (see forecastScenario's deficit cascade).
 */
export function deriveDrainOrder(strategy: Exclude<WithdrawalStrategy, "custom">, accounts: Account[]): DrainStop[] {
  return accountsInStrategyOrder(strategy, accounts).map((a) => fullStop(a.id, `strategy:${a.id}`));
}

/** The same order with fresh ids, for writing into the plan when the user picks "Customize". */
export function materializeDrainOrder(strategy: Exclude<WithdrawalStrategy, "custom">, accounts: Account[]): DrainStop[] {
  return accountsInStrategyOrder(strategy, accounts).map((a) => fullStop(a.id, nanoid()));
}

/** Accounts the presets would drain that a custom order never reaches: they will never cover a shortfall. */
export function unreachableAccounts(drainOrder: DrainStop[], accounts: Account[]): Account[] {
  const listed = new Set(drainOrder.map((s) => s.accountId));
  return accounts.filter((a) => drainTierOf(a) !== null && !listed.has(a.id));
}
