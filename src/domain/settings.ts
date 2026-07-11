import { z } from "zod";
import { idSchema, isoDateSchema } from "./common";

/**
 * A stop in the surplus "fill order" -- an account that can receive routed
 * surplus cash, in list order (first stop = filled first; overflow spills to
 * the next stop). Replaces the old per-account isSurplusTarget /
 * surplusTargetPriority / maxBalance / maxBalanceGrowthRatePct fields: the
 * *values* (cap, cap growth rate) are unchanged, just relocated here so
 * they're edited from one Money Flow view instead of scattered across every
 * account's form.
 */
export const moneyFlowStopSchema = z.object({
  accountId: idSchema,
  /** Ceiling for surplus routing into this account; null = uncapped (a catch-all). */
  maxBalance: z.number().nonnegative().nullable().default(null),
  /** Annual growth of the cap; null = follow settings.inflationRatePct. */
  maxBalanceGrowthRatePct: z.number().nullable().default(null),
  /** Only used when splitMode = "fixed_split": this stop's share of surplus (0..1). */
  splitPct: z.number().min(0).max(1).nullable().default(null),
});
export type MoneyFlowStop = z.infer<typeof moneyFlowStopSchema>;

/**
 * A spending-account hub -- income deposits here, expenses pay from here.
 * Multiple hubs are swept independently (each keeps its own buffer, and
 * shares the same fill/drain order). Replaces isSpendingAccount + targetCashBalance.
 */
export const moneyFlowHubSchema = z.object({
  accountId: idSchema,
  /** Buffer kept here (today's dollars, grown by inflation) before sweeping surplus. null/0 = sweep everything. */
  bufferAmount: z.number().nonnegative().nullable().default(null),
});
export type MoneyFlowHub = z.infer<typeof moneyFlowHubSchema>;

/**
 * How cash moves between accounts: which account(s) are the spending hub,
 * where surplus goes when there's extra, and what gets drained first when
 * there's a shortfall. This is the single source of truth for cash-flow
 * routing -- edited from the Money Flow view, not per-account forms.
 */
export const moneyFlowSchema = z.object({
  hubs: z.array(moneyFlowHubSchema).default([]),
  /** Ordered surplus targets; first stop filled first, overflow spills onward. */
  fillOrder: z.array(moneyFlowStopSchema).default([]),
  /** Ordered drain sources for covering a shortfall; first entry drawn first. */
  drainOrder: z.array(idSchema).default([]),
  splitMode: z.enum(["priority_fill", "fixed_split"]).default("priority_fill"),
});
export type MoneyFlow = z.infer<typeof moneyFlowSchema>;

export const DEFAULT_MONEY_FLOW: MoneyFlow = {
  hubs: [],
  fillOrder: [],
  drainOrder: [],
  splitMode: "priority_fill",
};

/**
 * Effective tax rates applied when money is withdrawn from an account, keyed by
 * the account's tax treatment. Income is entered as take-home (already taxed),
 * so these bite only on retirement-account draws -- RMDs and shortfall
 * withdrawals. Withdrawals are grossed up so the after-tax amount covers the
 * need. tax_free (Roth) is typically 0; taxable uses a capital-gains proxy
 * applied to the whole draw (no cost-basis tracking yet).
 */
export const withdrawalTaxRatesSchema = z.object({
  taxDeferredPct: z.number().min(0).max(1).default(0),
  taxablePct: z.number().min(0).max(1).default(0),
  taxFreePct: z.number().min(0).max(1).default(0),
});
export type WithdrawalTaxRates = z.infer<typeof withdrawalTaxRatesSchema>;

/**
 * Sensible starting rates: a blended effective ordinary-income rate on
 * tax-deferred draws, a long-term capital-gains proxy on taxable draws, and 0
 * on Roth. Users override these in Assumptions to match their bracket and state.
 */
export const DEFAULT_WITHDRAWAL_TAX_RATES: WithdrawalTaxRates = {
  taxDeferredPct: 0.22,
  taxablePct: 0.15,
  taxFreePct: 0,
};

export const forecastSettingsSchema = z.object({
  startDate: isoDateSchema,
  /** Derived from the longest planningEndAge, or an explicit override. */
  horizonEndDate: isoDateSchema,
  /** Global default, e.g. 0.03 for 3%. */
  inflationRatePct: z.number(),
  moneyFlow: moneyFlowSchema.default(DEFAULT_MONEY_FLOW),
  rmdEnabled: z.boolean().default(true),
  /** Defaults to DEFAULT_WITHDRAWAL_TAX_RATES; users override in Assumptions. */
  withdrawalTaxRates: withdrawalTaxRatesSchema.default(DEFAULT_WITHDRAWAL_TAX_RATES),
});
export type ForecastSettings = z.infer<typeof forecastSettingsSchema>;
