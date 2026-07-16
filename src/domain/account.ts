import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";

export const accountClassSchema = z.enum([
  "cash",
  "taxable_investment",
  "tax_deferred",
  "tax_free",
  "real_estate",
  "other_asset",
  "credit_card",
  "loan",
  "mortgage",
]);
export type AccountClass = z.infer<typeof accountClassSchema>;

export const accountCategorySchema = z.enum(["asset", "liability"]);
export type AccountCategory = z.infer<typeof accountCategorySchema>;

export const LIABILITY_CLASSES: readonly AccountClass[] = ["credit_card", "loan", "mortgage"];

export function categoryForClass(cls: AccountClass): AccountCategory {
  return LIABILITY_CLASSES.includes(cls) ? "liability" : "asset";
}

export const taxTreatmentSchema = z.enum(["taxable", "tax_deferred", "tax_free", "n/a"]);
export type TaxTreatment = z.infer<typeof taxTreatmentSchema>;

export const loanTermsSchema = z.object({
  originalPrincipal: z.number().nonnegative(),
  originationDate: isoDateSchema,
  annualInterestRatePct: z.number().min(0).max(1),
  termMonths: z.number().int().positive(),
  /** Computed via standard amortization if omitted. */
  monthlyPayment: z.number().nonnegative().optional(),
  /** e.g. a mortgage's linked real_estate account. */
  linkedAssetId: idSchema.optional(),
});
export type LoanTerms = z.infer<typeof loanTermsSchema>;

/**
 * A recurring contribution into this account. Whether it's a cash outflow is
 * driven by `payrollDeducted`, NOT by tax treatment -- a Roth 401(k) is
 * after-tax yet still deducted from your paycheck, while a Roth IRA is after-tax
 * but funded from your bank account. What matters for cash flow is only whether
 * the money is taken out before it reaches your take-home pay:
 *  - payrollDeducted true (401k/457/403b, traditional OR Roth): grows the
 *    account with NO cash outflow, since take-home income is entered net of it.
 *  - payrollDeducted false (Roth IRA, taxable brokerage, savings): grows the
 *    account AND draws from the spending account (riding the deficit cascade).
 */
export const contributionSchema = z.object({
  amount: z.number().positive(),
  frequency: recurrenceFrequencySchema,
  /** Nominal (actual) annual growth of the contribution amount; 0 = flat. */
  growthRatePct: z.number().default(0),
  /** True = taken from your paycheck before take-home (no cash outflow). */
  payrollDeducted: z.boolean().default(false),
  /**
   * Contributions stop after this date. Left unset, the engine stops them
   * automatically at the owning person's retirement (a paycheck-deducted
   * contribution can't outlive the paycheck). Set it to stop earlier, or to
   * cap a jointly-owned account's contribution that has no single retiree.
   */
  endDate: isoDateSchema.nullable().optional(),
});
export type Contribution = z.infer<typeof contributionSchema>;

/** One entry in a growth-rate schedule: the account's rate from `startDate` until the next entry starts (or indefinitely, for the last one). */
export const growthRateScheduleEntrySchema = z.object({
  startDate: isoDateSchema,
  /** Nominal (actual) annual rate, replacing the account's base growthRatePct from this date. */
  ratePct: z.number(),
});
export type GrowthRateScheduleEntry = z.infer<typeof growthRateScheduleEntrySchema>;

/**
 * One segment of a multi-segment contribution schedule -- same shape as
 * Contribution, plus its own startDate (and optional endDate; an omitted
 * endDate runs until the next segment's startDate, or indefinitely for the
 * last segment). When an account has `contributionSchedule` set, it
 * supersedes the single `contribution` entirely.
 */
export const contributionScheduleSegmentSchema = z.object({
  startDate: isoDateSchema,
  amount: z.number().positive(),
  frequency: recurrenceFrequencySchema,
  /** Nominal (actual) annual growth of this segment's contribution amount; 0 = flat. */
  growthRatePct: z.number().default(0),
  payrollDeducted: z.boolean().default(false),
  /** null/omitted = runs until the next segment's startDate, or indefinitely for the last segment. */
  endDate: isoDateSchema.nullable().optional(),
});
export type ContributionScheduleSegment = z.infer<typeof contributionScheduleSegmentSchema>;

// Kept separate from accountSchema below because Zod v4 forbids .omit()/.pick()
// on a refined schema at runtime (throws, despite type-checking) -- callers
// that need a sub-shape (e.g. a create-account form omitting `id`) should
// build off this raw object schema instead.
//
// Cash-flow ROLE (spending hub / surplus target / drain order / buffers /
// caps) deliberately does NOT live here -- it lives in
// ForecastSettings.moneyFlow as two ordered lists (fill order, drain order),
// edited from the Routing tab rather than scattered across every account's
// form. An account only needs to exist and be selectable there; nothing
// about *this* object's shape encodes its routing role.
export const accountObjectSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    class: accountClassSchema,
    category: accountCategorySchema,
    ownerId: idSchema.nullable(),
    startingBalance: z.number(),
    /** Annual rate, nominal (already includes inflation). */
    growthRatePct: z.number(),
    /** Visible and editable, but the engine skips it entirely: no growth, no
     *  cashflows, no effect on net worth, KPIs, or subtotals. For money you
     *  don't want counted as part of the plan (e.g. a kid's UTMA) while
     *  still keeping a record of it. */
    isExcluded: z.boolean().optional(),
    /**
     * Marks the one mandatory, undeletable system account that captures 100%
     * of net income-minus-expenses every month -- see ForecastSettings.moneyFlow
     * and scenarioSchema's auto-inject transform. Exactly one account per
     * scenario should carry this; enforced by construction (scenarioSchema),
     * not by this schema.
     */
    isExtraSavings: z.boolean().optional(),
    taxTreatment: taxTreatmentSchema.default("n/a"),
    /** Only meaningful when class='tax_deferred' and ownerId is set. */
    subjectToRMD: z.boolean().default(false),
    /** Present only for credit_card | loan | mortgage. */
    loanTerms: loanTermsSchema.optional(),
    /** Present only for real_estate; overrides growthRatePct if set. */
    propertyGrowthRatePct: z.number().optional(),
    /** Present only for real_estate, points at its mortgage Account. */
    linkedLiabilityId: idSchema.optional(),
    /** Optional recurring contribution into this account. Ignored when contributionSchedule is set. */
    contribution: contributionSchema.nullable().optional(),
    /** Optional date-ranged growth-rate schedule; growthRatePct above is the rate before the first entry starts. See resolveEvents.ts. */
    growthRateSchedule: z.array(growthRateScheduleEntrySchema).optional(),
    /** Optional date-ranged contribution schedule; supersedes the single `contribution` field when present. */
    contributionSchedule: z.array(contributionScheduleSegmentSchema).optional(),
  });

export const accountSchema = accountObjectSchema.refine(
  (a) => categoryForClass(a.class) === a.category,
  { message: "category must match class (asset vs liability)", path: ["category"] }
);
export type Account = z.infer<typeof accountSchema>;
