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

// Kept separate from accountSchema below because Zod v4 forbids .omit()/.pick()
// on a refined schema at runtime (throws, despite type-checking) -- callers
// that need a sub-shape (e.g. a create-account form omitting `id`) should
// build off this raw object schema instead.
export const accountObjectSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    class: accountClassSchema,
    category: accountCategorySchema,
    ownerId: idSchema.nullable(),
    startingBalance: z.number(),
    /** Annual rate; falls back to ForecastSettings.defaultGrowthByClass if unset. */
    growthRatePct: z.number(),
    isExcluded: z.boolean().default(false),
    linkedExternally: z.boolean().default(false),
    /** Stub flag -- no real bank sync in this build; manually settable for UI fidelity. */
    balanceUpdateRequired: z.boolean().optional(),
    /** Lower = drawn first to cover a deficit. null = not a funding source. */
    withdrawalPriority: z.number().int().nullable().default(null),
    isSpendingAccount: z.boolean().default(false),
    /**
     * For a spending account: keep this much cash here (a buffer) before
     * sweeping the excess to surplus targets. Entered in today's dollars and
     * grown with inflation. Unset/0 = sweep everything (legacy behavior).
     */
    targetCashBalance: z.number().nonnegative().nullable().optional(),
    isSurplusTarget: z.boolean().default(false),
    /** Lower = filled first when routing surplus. */
    surplusTargetPriority: z.number().int().nullable().default(null),
    /**
     * Ceiling for surplus routing: this account is filled only up to maxBalance,
     * then the overflow spills to the next-priority surplus target. null = no cap
     * (absorbs everything, the legacy behavior). Grows yearly per
     * `maxBalanceGrowthRatePct`.
     */
    maxBalance: z.number().nonnegative().nullable().default(null),
    /** Annual growth of maxBalance; null = follow ForecastSettings.inflationRatePct. */
    maxBalanceGrowthRatePct: z.number().nullable().default(null),
    taxTreatment: taxTreatmentSchema.default("n/a"),
    /** Only meaningful when class='tax_deferred' and ownerId is set. */
    subjectToRMD: z.boolean().default(false),
    /** Present only for credit_card | loan | mortgage. */
    loanTerms: loanTermsSchema.optional(),
    /** Present only for real_estate; overrides growthRatePct if set. */
    propertyGrowthRatePct: z.number().optional(),
    /** Present only for real_estate, points at its mortgage Account. */
    linkedLiabilityId: idSchema.optional(),
    /** Optional recurring contribution into this account. */
    contribution: contributionSchema.nullable().optional(),
  });

export const accountSchema = accountObjectSchema.refine(
  (a) => categoryForClass(a.class) === a.category,
  { message: "category must match class (asset vs liability)", path: ["category"] }
);
export type Account = z.infer<typeof accountSchema>;
