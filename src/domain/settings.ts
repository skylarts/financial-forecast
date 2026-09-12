import { z } from "zod";
import { nanoid } from "nanoid";
import { idSchema, isoDateSchema } from "./common";

/**
 * The window a routing stop's `limitAmount` is measured over. Deliberately
 * limited to whole multiples of a month: the engine simulates month by month
 * (see forecastScenario's monthly loop), so a daily or weekly limit could not
 * be honored and would be a setting that silently lies. Monthly and annual
 * cover the real cases -- a steady per-paycheck sweep, or an IRS-style yearly
 * contribution room -- and quarterly is free since it's a multiple of months.
 */
export const flowLimitPeriodSchema = z.enum(["monthly", "quarterly", "annual"]);
export type FlowLimitPeriod = z.infer<typeof flowLimitPeriodSchema>;

/**
 * A stop in the "Extra Savings" surplus split -- an account that can receive
 * a share of that month's FRESH surplus, in list order. Each stop is either
 * a flat dollar amount ("kind: flat") or a percentage of whatever's left
 * after the stops above it have taken their share ("kind: percent_of_remainder",
 * cascading -- not a percentage of the original total). Whatever the whole
 * list doesn't claim simply stays in Extra Savings.
 *
 * `limitAmount` caps how much this stop may route over `limitPeriod`,
 * resetting each period -- the natural way to express an annual contribution
 * room ("$7,000/yr into the Roth IRA, then spill onward"). It bounds the FLOW
 * through this rule; the target account's own `balanceCeiling` bounds the
 * resulting BALANCE, and both apply, whichever binds first.
 *
 * The optional date window mirrors drainStopSchema's: it lets a stop only
 * receive surplus for part of the plan -- e.g. an account that shouldn't
 * start filling until a few years before retirement.
 */
export const splitStopSchema = z.object({
  id: idSchema.default(() => nanoid()),
  accountId: idSchema,
  kind: z.enum(["flat", "percent_of_remainder"]).default("percent_of_remainder"),
  /** Used when kind = "flat": a fixed dollar amount (today's dollars, grown by inflation) taken off the top. */
  amount: z.number().nonnegative().nullable().default(null),
  /** Used when kind = "percent_of_remainder": this stop's share (0..1) of what's left after stops above it. */
  pct: z.number().min(0).max(1).nullable().default(null),
  /** Most this stop may route per `limitPeriod` (today's dollars, grown by `limitGrowthRatePct`); null = unlimited. */
  limitAmount: z.number().nonnegative().nullable().optional(),
  /** The window `limitAmount` is measured over; omitted = "annual". Ignored when limitAmount is null. */
  limitPeriod: flowLimitPeriodSchema.optional(),
  /** Annual growth of the limit; null/omitted = follow settings.inflationRatePct. */
  limitGrowthRatePct: z.number().nullable().optional(),
  /** null = active from the plan's start. */
  startDate: isoDateSchema.nullable().default(null),
  /** null = active through the plan's end. */
  endDate: isoDateSchema.nullable().default(null),
  /**
   * DEPRECATED -- the target account's `balanceCeiling` replaced this. Still
   * parsed so plans saved before the move keep loading; scenarioSchema's
   * transform lifts any value found here onto the account and clears it, and
   * the engine reads only the account field. Do not write to these.
   */
  maxBalance: z.number().nonnegative().nullable().default(null),
  /** DEPRECATED -- see maxBalance. */
  maxBalanceGrowthRatePct: z.number().nullable().default(null),
});
export type SplitStop = z.infer<typeof splitStopSchema>;

/**
 * A stop in the shortfall "drain order" -- an account that can cover a cash
 * shortfall, in list order. Mirrors splitStopSchema's cascading model: each
 * stop is either a flat $ amount or a percentage of what's left after the
 * stops above it (cascading, not a share of the original shortfall) --
 * whatever a stop can't cover spills to the next stop.
 *
 * `limitAmount` caps how much this stop may draw over `limitPeriod`,
 * resetting each period. That's a bound on the SPEED of the drawdown ("no
 * more than $40k out of the brokerage a year", to keep realized gains inside
 * a bracket); the source account's own `balanceFloor` bounds how far down it
 * may go. The two are not interchangeable -- a rate limit can't see the
 * balance, so on its own it will happily drain straight through a floor --
 * and both apply, whichever binds first.
 *
 * The optional date window lets a stop participate only for part of the
 * plan -- e.g. an account that funds a shortfall for a few years until
 * another one becomes available.
 *
 * Has its own `id` (independent of `accountId`) so the SAME account can
 * appear more than once with different windows -- e.g. drain account A,
 * then account B, then back to account A for the rest of the plan.
 */
export const drainStopSchema = z.object({
  /** Stable identity for this list entry -- NOT unique per account; the same accountId may appear in multiple stops. */
  id: idSchema.default(() => nanoid()),
  accountId: idSchema,
  kind: z.enum(["flat", "percent_of_remainder"]).default("percent_of_remainder"),
  /** Used when kind = "flat": a fixed dollar amount (today's dollars, grown by inflation) taken off the top. */
  amount: z.number().nonnegative().nullable().default(null),
  /**
   * Used when kind = "percent_of_remainder": this stop's share (0..1) of
   * what's left after stops above it. Defaults to 1 (not null, unlike
   * splitStopSchema's pct) so a plan saved before this field existed keeps
   * behaving exactly like the old default: drain this stop fully before
   * moving to the next.
   */
  pct: z.number().min(0).max(1).nullable().default(1),
  /** Most this stop may draw per `limitPeriod` (today's dollars, grown by `limitGrowthRatePct`); null = unlimited. */
  limitAmount: z.number().nonnegative().nullable().optional(),
  /** The window `limitAmount` is measured over; omitted = "annual". Ignored when limitAmount is null. */
  limitPeriod: flowLimitPeriodSchema.optional(),
  /** Annual growth of the limit; null/omitted = follow settings.inflationRatePct. */
  limitGrowthRatePct: z.number().nullable().optional(),
  /** null = active from the plan's start. */
  startDate: isoDateSchema.nullable().default(null),
  /** null = active through the plan's end. */
  endDate: isoDateSchema.nullable().default(null),
  /**
   * DEPRECATED -- the source account's `balanceFloor` replaced this. Still
   * parsed so plans saved before the move keep loading; scenarioSchema's
   * transform lifts any value found here onto the account and clears it, and
   * the engine reads only the account field. Do not write to these.
   */
  minBalance: z.number().nonnegative().nullable().default(null),
  /** DEPRECATED -- see minBalance. */
  minBalanceGrowthRatePct: z.number().nullable().default(null),
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
 * decides what covers a shortfall using the same cascading kind/amount/pct
 * model. Edited from the Routing tab, not per-account forms.
 *
 * These lists own FLOW only -- priority, share, date window, and how much may
 * move per period. An account's balance bounds (`balanceCeiling` /
 * `balanceFloor`) live on the account itself, since they hold regardless of
 * which rule moved the money. See accountObjectSchema.
 */
export const moneyFlowSchema = z.object({
  /** Ordered surplus split; first stop offered first, cascading remainder spills onward. */
  splitOrder: z.array(splitStopSchema).default([]),
  /** Ordered drain sources for covering a shortfall; first (active) entry drained first, cascading remainder spills onward. */
  drainOrder: drainOrderSchema.default([]),
});
export type MoneyFlow = z.infer<typeof moneyFlowSchema>;

export const DEFAULT_MONEY_FLOW: MoneyFlow = {
  splitOrder: [],
  drainOrder: [],
};

export const filingStatusSchema = z.enum(["single", "marriedFilingJointly"]);
export type FilingStatus = z.infer<typeof filingStatusSchema>;

/**
 * Which accounts cover a shortfall, and in what order. The three presets are
 * derived from the account list at run time (see engine/strategy.ts), so an
 * account added later is never left unreachable; "custom" means the engine
 * reads `moneyFlow.drainOrder` exactly as the Routing tab's editor left it.
 *
 *  - conventional: cash, then taxable, then tax-deferred, then Roth last.
 *  - tax_deferred_first: cash, then tax-deferred (fill the low brackets
 *    before Social Security and RMDs arrive), then taxable, then Roth.
 *  - pro_rata: cash first, then every investment account in proportion to
 *    its balance.
 */
export const withdrawalStrategySchema = z.enum(["conventional", "tax_deferred_first", "pro_rata", "custom"]);
export type WithdrawalStrategy = z.infer<typeof withdrawalStrategySchema>;

/**
 * The healthcare model: what coverage costs at each stage of life, driven by
 * the household's own income where the real rules are (the marketplace
 * premium credit, Medicare's income-related surcharges). Every dollar figure
 * is today's dollars, per person per month unless the name says otherwise,
 * and grows at `costGrowthRatePct`. See engine/healthcare.ts for the rules
 * and the tables (2026 figures).
 *
 * Off by default: a plan that entered its premiums as ordinary expenses
 * keeps working exactly as before. Turning it on replaces those entries.
 */
export const healthcareSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Yearly growth of every healthcare cost; null = the plan's inflation rate. Medical costs have outrun general inflation for decades, so the default sits above it. */
  costGrowthRatePct: z.number().nullable().default(0.05),
  /** What coverage costs out of take-home while someone in the household has a salary. 0 = the paycheck deduction is already reflected in the take-home pay you entered. */
  workingMonthlyPremiumPerPerson: z.number().nonnegative().default(0),
  /** A working member's plan covers everyone under 65 (so a retired spouse costs the working premium, not a marketplace one). */
  spouseCoverageWhileWorking: z.boolean().default(true),
  /** Coverage for anyone under 65 once nobody in the household is working. */
  retiredCoverage: z.enum(["marketplace", "cobra_then_marketplace", "fixed", "none"]).default("marketplace"),
  /** For "fixed": a retiree plan or any other flat premium. */
  fixedMonthlyPremiumPerPerson: z.number().nonnegative().default(600),
  cobra: z
    .object({
      months: z.number().int().nonnegative().default(18),
      monthlyPremiumPerPerson: z.number().nonnegative().default(750),
    })
    .prefault({}),
  marketplace: z
    .object({
      /** The full, unsubsidized price of the benchmark (second-lowest silver) plan for this person today, at their current age. */
      benchmarkMonthlyPremiumPerPerson: z.number().nonnegative().default(650),
      /** Scale the premium with age along the standard federal age curve (a 60-year-old pays about 2.1x a 40-year-old). */
      ageRated: z.boolean().default(true),
      /** Apply the premium tax credit: the household's cost is capped at a share of its income when income is between one and four times the poverty line. */
      premiumTaxCredit: z.boolean().default(true),
      /** Model the 2021-2025 enhanced credits (no income cap, 8.5% ceiling) instead of the schedule in current law. */
      enhancedSubsidies: z.boolean().default(false),
    })
    .prefault({}),
  medicare: z
    .object({
      /** Part D (drug) plan premium, before any income surcharge. */
      partDMonthlyPremium: z.number().nonnegative().default(45),
      /** A Medigap supplement or Medicare Advantage premium. */
      supplementMonthlyPremium: z.number().nonnegative().default(150),
      /** Apply IRMAA: the Part B and Part D surcharges driven by the household's income two years earlier. */
      irmaa: z.boolean().default(true),
    })
    .prefault({}),
  outOfPocket: z
    .object({
      /** Deductibles, copays, dental, vision -- per person per year, before Medicare. */
      preMedicareAnnualPerPerson: z.number().nonnegative().default(2_000),
      /** Same, on Medicare. */
      medicareAnnualPerPerson: z.number().nonnegative().default(2_500),
      /** Pay out-of-pocket costs from a health savings account while it has a balance. */
      payFromHsa: z.boolean().default(true),
    })
    .prefault({}),
});
export type HealthcareSettings = z.infer<typeof healthcareSettingsSchema>;

const forecastSettingsObjectSchema = z.object({
  /**
   * null = every account's starting balance is treated as of TODAY, live --
   * recomputed on every load rather than frozen at whatever date the plan
   * happened to be created. Set an explicit date only to override that (a
   * past date to backdate the plan, or a future one to model "if I started
   * this plan on X"). See the Start Date field's tooltip in AssumptionsDrawer.
   */
  startDate: isoDateSchema.nullable().default(null),
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
  /**
   * Which accounts cover a shortfall, and in what order. Absent on plans
   * saved before it existed: those keep a hand-built drain order as
   * "custom", and a plan with no drain order at all gets "conventional" --
   * the safety net for a scratch scenario that used to run dry silently.
   */
  withdrawalStrategy: withdrawalStrategySchema.optional(),
  /**
   * Cash to keep on hand in Extra Savings (today's dollars, grown by
   * inflation). The withdrawal routing tops it back up whenever spending
   * draws it down, so retirement does not leave cash sitting at $0 between
   * bills. null = no buffer (draw exactly what each month needs).
   */
  cashBufferTarget: z.number().nonnegative().nullable().default(null),
  /**
   * One expected return for every investment account (taxable, tax-deferred,
   * Roth, HSA, 529). While set, each account's own growth rate and scheduled
   * changes are ignored; null = off, every account uses its own rate. Cash
   * and real estate never follow it.
   */
  planReturnRatePct: z.number().nullable().default(null),
  healthcare: healthcareSettingsSchema.prefault({}),
});

export const forecastSettingsSchema = forecastSettingsObjectSchema.transform((s) => ({
  ...s,
  withdrawalStrategy: s.withdrawalStrategy ?? (s.moneyFlow.drainOrder.length > 0 ? ("custom" as const) : ("conventional" as const)),
}));
export type ForecastSettings = z.infer<typeof forecastSettingsSchema>;
/** The default healthcare block, for code that builds a settings object by hand. */
export const DEFAULT_HEALTHCARE_SETTINGS: HealthcareSettings = healthcareSettingsSchema.parse({});
