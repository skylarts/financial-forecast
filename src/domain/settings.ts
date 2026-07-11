import { z } from "zod";
import { idSchema, isoDateSchema } from "./common";
import { accountClassSchema } from "./account";

export const surplusRoutingRuleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("priority_fill") }),
  z.object({
    mode: z.literal("fixed_split"),
    splits: z.array(z.object({ accountId: idSchema, pct: z.number().min(0).max(1) })),
  }),
]);
export type SurplusRoutingRule = z.infer<typeof surplusRoutingRuleSchema>;

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
  defaultGrowthByClass: z.record(accountClassSchema, z.number()),
  surplusRoutingRule: surplusRoutingRuleSchema,
  rmdEnabled: z.boolean().default(true),
  /** Defaults to DEFAULT_WITHDRAWAL_TAX_RATES; users override in Assumptions. */
  withdrawalTaxRates: withdrawalTaxRatesSchema.default(DEFAULT_WITHDRAWAL_TAX_RATES),
});
export type ForecastSettings = z.infer<typeof forecastSettingsSchema>;
