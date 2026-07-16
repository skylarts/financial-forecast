import { z } from "zod";
import { nanoid } from "nanoid";
import { idSchema, isoDateSchema } from "./common";

/**
 * A stop in the "Extra Savings" surplus split -- an account that can receive
 * a share of that month's FRESH surplus, in list order. Each stop is either
 * a flat dollar amount ("kind: flat") or a percentage of whatever's left
 * after the stops above it have taken their share ("kind: percent_of_remainder",
 * cascading -- not a percentage of the original total). Whatever the whole
 * list doesn't claim simply stays in Extra Savings.
 *
 * `maxBalance` is the one thing carried over unchanged from the old fill
 * order: a balance ceiling on the TARGET account, independent of the flat/%
 * allocation above -- if a stop's offered share would push its account over
 * this ceiling, only the room up to the ceiling is taken and the rest
 * cascades to the next stop, same spillover behavior as before.
 */
export const splitStopSchema = z.object({
  id: idSchema.default(() => nanoid()),
  accountId: idSchema,
  kind: z.enum(["flat", "percent_of_remainder"]).default("percent_of_remainder"),
  /** Used when kind = "flat": a fixed dollar amount (today's dollars, grown by inflation) taken off the top. */
  amount: z.number().nonnegative().nullable().default(null),
  /** Used when kind = "percent_of_remainder": this stop's share (0..1) of what's left after stops above it. */
  pct: z.number().min(0).max(1).nullable().default(null),
  /** Balance ceiling on the target account; null = uncapped (a catch-all). */
  maxBalance: z.number().nonnegative().nullable().default(null),
  /** Annual growth of the cap; null = follow settings.inflationRatePct. */
  maxBalanceGrowthRatePct: z.number().nullable().default(null),
});
export type SplitStop = z.infer<typeof splitStopSchema>;

/**
 * A stop in the shortfall "drain order" -- an account that can cover a cash
 * shortfall, in list order (first stop drained first, unless drainSplitMode
 * = "fixed_split"). The optional date window lets a stop participate only
 * for part of the plan -- e.g. an account that funds a shortfall for a few
 * years until another one becomes available.
 *
 * Has its own `id` (independent of `accountId`) so the SAME account can
 * appear more than once with different windows -- e.g. drain account A,
 * then account B, then back to account A for the rest of the plan.
 */
export const drainStopSchema = z.object({
  /** Stable identity for this list entry -- NOT unique per account; the same accountId may appear in multiple stops. */
  id: idSchema.default(() => nanoid()),
  accountId: idSchema,
  /** null = active from the plan's start. */
  startDate: isoDateSchema.nullable().default(null),
  /** null = active through the plan's end. */
  endDate: isoDateSchema.nullable().default(null),
  /** Only used when drainSplitMode = "fixed_split": this stop's share of the shortfall (0..1). */
  splitPct: z.number().min(0).max(1).nullable().default(null),
  /** Minimum balance (today's dollars, grown by inflation) this stop won't be drained below; null = no floor. */
  minBalance: z.number().nonnegative().nullable().default(null),
});
export type DrainStop = z.infer<typeof drainStopSchema>;

/**
 * Accepts either the current shape (an array of stop objects) or the legacy
 * shape (a plain array of account id strings, from before drain stops had
 * date windows / splitting) -- normalizes the legacy shape into the current
 * one so an already-saved plan keeps parsing without losing its configured
 * drain order. Stop objects saved before `id` existed get one generated
 * here too (drainStopSchema's own default only fires for a MISSING key, so
 * this still works for those).
 */
const drainOrderSchema = z.preprocess((val) => {
  if (!Array.isArray(val)) return val;
  return val.map((entry) => (typeof entry === "string" ? { accountId: entry } : entry));
}, z.array(drainStopSchema));

/**
 * How cash moves between accounts. There is no user-configurable "hub" here
 * anymore -- the mandatory Extra Savings system account (see
 * scenarioSchema's auto-inject transform in scenario.ts) is the sole hub: it
 * captures 100% of net income-minus-expenses every month with a hardcoded
 * $0 floor, `splitOrder` decides where that surplus goes, and `drainOrder`
 * (unchanged from before) decides what covers a shortfall. Edited from the
 * Routing tab, not per-account forms.
 */
export const moneyFlowSchema = z.object({
  /** Ordered surplus split; first stop offered first, cascading remainder spills onward. */
  splitOrder: z.array(splitStopSchema).default([]),
  /** Ordered drain sources for covering a shortfall; first (active) entry drawn first. */
  drainOrder: drainOrderSchema.default([]),
  drainSplitMode: z.enum(["priority_fill", "fixed_split"]).default("priority_fill"),
});
export type MoneyFlow = z.infer<typeof moneyFlowSchema>;

export const DEFAULT_MONEY_FLOW: MoneyFlow = {
  splitOrder: [],
  drainOrder: [],
  drainSplitMode: "priority_fill",
};

export const filingStatusSchema = z.enum(["single", "marriedFilingJointly"]);
export type FilingStatus = z.infer<typeof filingStatusSchema>;

export const forecastSettingsSchema = z.object({
  startDate: isoDateSchema,
  /** Derived from the longest planningEndAge, or an explicit override. */
  horizonEndDate: isoDateSchema,
  /** Global default, e.g. 0.03 for 3%. */
  inflationRatePct: z.number(),
  moneyFlow: moneyFlowSchema.default(DEFAULT_MONEY_FLOW),
  rmdEnabled: z.boolean().default(true),
  /**
   * Drives which 2026 IRS bracket table (and Social Security thresholds)
   * federal tax is computed from -- see engine/taxTables.ts.
   */
  filingStatus: filingStatusSchema.default("marriedFilingJointly"),
  /**
   * Optional flat add-on (state/local tax, or anything else not modeled)
   * applied on top of the computed federal tax. Default 0 -- e.g. correct
   * as-is for a no-income-tax state like Texas.
   */
  additionalFlatTaxRatePct: z.number().min(0).max(1).default(0),
});
export type ForecastSettings = z.infer<typeof forecastSettingsSchema>;
