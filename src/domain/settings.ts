import { z } from "zod";
import { nanoid } from "nanoid";
import { idSchema, isoDateSchema } from "./common";

/**
 * A stop in the surplus "fill order" -- an account that can receive routed
 * surplus cash, in list order (first stop = filled first; overflow spills to
 * the next stop). Replaces the old per-account isSurplusTarget /
 * surplusTargetPriority / maxBalance / maxBalanceGrowthRatePct fields: the
 * *values* (cap, cap growth rate) are unchanged, just relocated here so
 * they're edited from one Routing tab instead of scattered across every
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
 *
 * The account floats between `bufferAmount` (the floor -- drop below it and
 * the deficit cascade pulls money back in) and `ceilingAmount` (the ceiling --
 * rise above it and the surplus above the ceiling sweeps out). A hub used to
 * need a SECOND entry in the fill order to express a ceiling different from
 * its floor -- except a fill-order entry pointing at the account it's being
 * swept FROM is always a no-op (the engine skips an account sweeping into
 * itself), so that second entry silently did nothing. `ceilingAmount` puts
 * both numbers on the same row instead. Omit it (or set it below the floor)
 * to fall back to the old single-number behavior, where the floor also acts
 * as the ceiling.
 */
export const moneyFlowHubSchema = z.object({
  accountId: idSchema,
  /** Floor (today's dollars, grown by inflation): drain-in trigger. null/0 = sweep everything, no floor. */
  bufferAmount: z.number().nonnegative().nullable().default(null),
  /**
   * Ceiling (today's dollars, grown by inflation): sweep-out trigger. null =
   * same as bufferAmount (legacy behavior). Optional (not defaulted) rather
   * than required-with-default, so every existing hand-built MoneyFlowHub
   * object literal in the codebase (mockScenario, testHelpers, older tests)
   * still type-checks without listing it.
   */
  ceilingAmount: z.number().nonnegative().nullable().optional(),
  /** Annual growth of the ceiling; null/omitted = follow settings.inflationRatePct. */
  ceilingGrowthRatePct: z.number().nullable().optional(),
});
export type MoneyFlowHub = z.infer<typeof moneyFlowHubSchema>;

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
 * How cash moves between accounts: which account(s) are the spending hub,
 * where surplus goes when there's extra, and what gets drained first when
 * there's a shortfall. This is the single source of truth for cash-flow
 * routing -- edited from the Routing tab, not per-account forms.
 *
 * Accepts an already-saved plan's legacy `splitMode` key (from before the
 * drain side had its own independent split mode) and renames it to
 * `fillSplitMode` so existing configuration isn't silently reset.
 */
export const moneyFlowSchema = z.preprocess((val) => {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if (obj.fillSplitMode === undefined && obj.splitMode !== undefined) {
      const { splitMode, ...rest } = obj;
      return { ...rest, fillSplitMode: splitMode };
    }
  }
  return val;
}, z.preprocess((val) => {
  // A hub used to need a fill-order entry pointing at ITSELF to express a
  // ceiling -- the engine always skipped it (an account can't sweep into
  // itself), so it silently had no effect. Fold any such self-referencing
  // entry into the hub's own ceilingAmount instead, and drop it from
  // fillOrder, so an already-saved plan with this exact dead configuration
  // starts behaving the way it looked like it should.
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const obj = val as Record<string, unknown>;
  const hubs = obj.hubs;
  const fillOrder = obj.fillOrder;
  if (!Array.isArray(hubs) || !Array.isArray(fillOrder) || hubs.length === 0 || fillOrder.length === 0) return val;
  const hubAccountIds = new Set(
    hubs.map((h) => (h && typeof h === "object" ? (h as Record<string, unknown>).accountId : undefined))
  );
  let migrated = false;
  const nextFillOrder: unknown[] = [];
  const ceilingByAccountId = new Map<unknown, { maxBalance: unknown; maxBalanceGrowthRatePct: unknown }>();
  for (const entry of fillOrder) {
    if (entry && typeof entry === "object" && hubAccountIds.has((entry as Record<string, unknown>).accountId)) {
      migrated = true;
      const e = entry as Record<string, unknown>;
      ceilingByAccountId.set(e.accountId, { maxBalance: e.maxBalance, maxBalanceGrowthRatePct: e.maxBalanceGrowthRatePct });
      continue; // drop the dead self-referencing entry
    }
    nextFillOrder.push(entry);
  }
  if (!migrated) return val;
  const nextHubs = hubs.map((h) => {
    if (!h || typeof h !== "object") return h;
    const hub = h as Record<string, unknown>;
    const ceiling = ceilingByAccountId.get(hub.accountId);
    if (!ceiling || hub.ceilingAmount !== undefined) return hub;
    return { ...hub, ceilingAmount: ceiling.maxBalance ?? null, ceilingGrowthRatePct: ceiling.maxBalanceGrowthRatePct ?? null };
  });
  return { ...obj, hubs: nextHubs, fillOrder: nextFillOrder };
}, z.object({
  hubs: z.array(moneyFlowHubSchema).default([]),
  /** Ordered surplus targets; first stop filled first, overflow spills onward. */
  fillOrder: z.array(moneyFlowStopSchema).default([]),
  /** Ordered drain sources for covering a shortfall; first (active) entry drawn first. */
  drainOrder: drainOrderSchema.default([]),
  fillSplitMode: z.enum(["priority_fill", "fixed_split"]).default("priority_fill"),
  drainSplitMode: z.enum(["priority_fill", "fixed_split"]).default("priority_fill"),
})));
export type MoneyFlow = z.infer<typeof moneyFlowSchema>;

export const DEFAULT_MONEY_FLOW: MoneyFlow = {
  hubs: [],
  fillOrder: [],
  drainOrder: [],
  fillSplitMode: "priority_fill",
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
