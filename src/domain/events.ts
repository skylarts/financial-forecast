import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";
import { dateAnchorFields } from "./anchor";

const baseEventFields = {
  id: idSchema,
  name: z.string().min(1),
  startDate: isoDateSchema,
  /** For temporary effects (career break); omitted/null = permanent. */
  endDate: isoDateSchema.nullable().optional(),
  ...dateAnchorFields,
  notes: z.string().optional(),
  /** Visible and editable, but the engine skips it entirely -- no effect on
   *  the projection. A lighter-weight "what if this didn't happen" toggle
   *  than duplicating a whole scenario. */
  isExcluded: z.boolean().optional(),
};

/**
 * Retirement is NOT an event. It lives on the person (see Person.retirementAge
 * and `retirementDateOf`), because it is a property of someone's life, not a
 * transaction on a date -- and because two places to say when you retire meant
 * one of them was always silently wrong. A `retire` event in an older plan is
 * folded onto its person by migrateV5Plan.
 */

export const buyHomeEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("buy_home"),
  /** Today's dollars -- inflated forward to startDate (the closing date) at
   *  save time to seed the linked account's startingBalance (a snapshot: if
   *  the plan's inflation assumption changes later, re-save this event to
   *  refresh it). See src/lib/buyHome.ts. */
  purchasePrice: z.number().positive(),
  downPaymentAmount: z.number().nonnegative(),
  /** Financed: funds the down payment. Cash: funds the whole purchase price. */
  downPaymentFromAccountId: idSchema,
  /** The real_estate account this purchase created (and, if financed, its
   *  linked mortgage via that account's own linkedLiabilityId) -- a real,
   *  permanent Account exactly like one added via "Add a Home You Already
   *  Own", editable on the Account tab and sellable via a later sell_home
   *  event. This event itself only records the purchase transaction; ongoing
   *  appreciation/tax/insurance/maintenance rates and mortgage terms live on
   *  the account from here on. See src/lib/buyHome.ts and HomeDrawer. */
  realEstateAccountId: idSchema,
  /** When true, any Expense with category "housing" stops the day before this
   *  purchase closes -- the old rent/mortgage payment it's replacing. */
  replaceHousingExpenses: z.boolean().optional(),
});
export type BuyHomeEvent = z.infer<typeof buyHomeEventSchema>;

export const sellHomeEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("sell_home"),
  /** The real_estate account being sold -- any real_estate account works,
   *  whether entered directly (Accounts tab / "add a home you already own")
   *  or created by an earlier buy_home event (both are real Accounts). */
  realEstateAccountId: idSchema,
  /** What actually lands in your account: sale price minus agent commission,
   *  closing costs, and whatever's left on the mortgage. Entered directly
   *  (not sale price minus costs separately) since the mortgage payoff isn't
   *  known until the projection runs -- today's dollars, inflated forward to
   *  the sale date like every other dollar amount in this app. Can be
   *  negative (an underwater sale where you bring cash to closing). */
  netProceeds: z.number(),
  /**
   * When set, the engine IGNORES netProceeds and computes the proceeds
   * itself at the sale month: the home's simulated value × (1 − this
   * fraction of selling costs) − whatever is left on the linked mortgage.
   * This keeps the credited cash consistent with the equity the model
   * itself projects at the sale date. null/omitted = use netProceeds
   * (the original fixed, inflation-adjusted entry).
   */
  sellingCostsPct: z.number().min(0).max(1).nullable().optional(),
  /** Where net proceeds land. null = Extra Savings. */
  proceedsAccountId: idSchema.nullable(),
});
export type SellHomeEvent = z.infer<typeof sellHomeEventSchema>;

/**
 * A Roth conversion: money moved from a tax-deferred account to a tax-free
 * one. Ordinary income in the year it happens, never the 10% penalty.
 * Either a fixed amount per occurrence, or "fill to the top of a bracket":
 * convert just enough each December to bring the year's ordinary taxable
 * income up to the top of the named bracket.
 */
export const rothConversionEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("roth_conversion"),
  fromAccountId: idSchema,
  toAccountId: idSchema,
  /** Today's dollars per occurrence. null when fillToBracketRate is set. */
  amount: z.number().positive().nullable().default(null),
  /** e.g. 0.12: convert up to the top of the 12% bracket each year. null = use `amount`. */
  fillToBracketRate: z.number().min(0).max(1).nullable().default(null),
  frequency: z.enum(["annual", "one_time"]).default("annual"),
  /** "cash": the tax is paid from the spending hub (the default and usual advice). "withhold": it is withheld from the converted amount, so less lands in the Roth. */
  taxSource: z.enum(["cash", "withhold"]).default("cash"),
  /** null/omitted = the fixed amount keeps pace with inflation; 0 = flat. */
  growthRatePct: z.number().nullable().optional(),
});
export type RothConversionEvent = z.infer<typeof rothConversionEventSchema>;

/** Pay a loan or mortgage down (or off) from an asset account on a date. */
export const payOffLoanEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("pay_off_loan"),
  loanAccountId: idSchema,
  fromAccountId: idSchema,
  /** Today's dollars. null = pay off whatever is left on that date. */
  amount: z.number().positive().nullable().default(null),
});
export type PayOffLoanEvent = z.infer<typeof payOffLoanEventSchema>;

/** Move money between two tax-deferred accounts (e.g. a 401k to an IRA). Not a taxable event. */
export const rolloverEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("rollover"),
  fromAccountId: idSchema,
  toAccountId: idSchema,
  /** Today's dollars. null = the whole balance on that date. */
  amount: z.number().positive().nullable().default(null),
});
export type RolloverEvent = z.infer<typeof rolloverEventSchema>;

/**
 * Take out a loan (a car loan, a student loan, a HELOC, a personal loan) on a
 * future date. Like buy_home, the event is thin: the `loan` account it created
 * is a real, permanent Account carrying the balance, rate, and term, and it
 * amortizes through the ordinary loan machinery from its own origination date.
 * All this event adds is the one thing an account cannot express -- where the
 * borrowed money went.
 */
export const openLoanEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("open_loan"),
  /** The `loan` account this event created and owns. */
  loanAccountId: idSchema,
  /**
   * What kind of borrowing this is. Both are one `loan` account underneath;
   * the kind decides how the form reads and how the Timeline labels it. A
   * "heloc" is secured by a home (loanTerms.linkedAssetId) and starts with an
   * interest-only draw period (loanTerms.interestOnlyMonths).
   */
  loanKind: z.enum(["fixed", "heloc"]).default("fixed"),
  /** Today's dollars -- inflated forward to startDate (the origination date),
   *  the same two-stage convention buy_home uses for a purchase price. */
  principal: z.number().positive(),
  /**
   * Where the borrowed money lands. null = it paid for something the plan
   * doesn't track (a car, a tuition bill), so no cash ever reaches an
   * account -- only the debt and its payments show up.
   */
  proceedsAccountId: idSchema.nullable().default(null),
});
export type OpenLoanEvent = z.infer<typeof openLoanEventSchema>;

/**
 * Replace a loan's rate and term on a date -- a refinance. The account keeps
 * its identity and its balance; only the terms change, because that is what a
 * refinance actually is. Optionally roll closing costs into the balance and
 * take cash out, both of which grow what is owed.
 *
 * It is NOT a new loan account: a plan that pointed at this mortgage (a
 * pay_off_loan event, a home's linkedLiabilityId) keeps pointing at it.
 */
export const refinanceEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("refinance"),
  /** The mortgage or loan being refinanced. */
  loanAccountId: idSchema,
  /** The new annual rate, as a fraction (0.055 = 5.5%). */
  annualInterestRatePct: z.number().min(0).max(1),
  /** The new term, counted from the refinance date. */
  termMonths: z.number().int().positive(),
  /** Today's dollars, inflated to the refinance date. Added to the balance and paid out as cash. */
  cashOutAmount: z.number().nonnegative().default(0),
  /** Where the cash-out lands. null = the spending hub. */
  cashOutAccountId: idSchema.nullable().default(null),
  /** Today's dollars, inflated to the refinance date. Lender fees, title, points. */
  closingCosts: z.number().nonnegative().default(0),
  /** true = rolled into the new balance (the usual "no-cost" refi); false = paid in cash at closing. */
  closingCostsFinanced: z.boolean().default(true),
  /** Carried over onto the new loan; blank keeps whatever the loan already had. */
  extraPrincipalMonthly: z.number().nonnegative().nullable().default(null),
});
export type RefinanceEvent = z.infer<typeof refinanceEventSchema>;

export const customTransferEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("custom_transfer"),
  amount: z.number().positive(),
  fromAccountId: idSchema,
  toAccountId: idSchema,
  frequency: recurrenceFrequencySchema,
  /** null/omitted = match the plan's inflation rate; 0 = flat in nominal terms. */
  growthRatePct: z.number().nullable().optional(),
  /** Repeat every N years (e.g. a car replaced every 7 yrs); overrides frequency. */
  intervalYears: z.number().int().positive().optional(),
});
export type CustomTransferEvent = z.infer<typeof customTransferEventSchema>;

export const scenarioEventSchema = z
  .discriminatedUnion("type", [
    buyHomeEventSchema,
    sellHomeEventSchema,
    rothConversionEventSchema,
    payOffLoanEventSchema,
    openLoanEventSchema,
    refinanceEventSchema,
    rolloverEventSchema,
    customTransferEventSchema,
  ])
  .refine(
    (e) =>
      !("fromAccountId" in e && "toAccountId" in e) || e.fromAccountId !== e.toAccountId,
    { message: "The two accounts must differ", path: ["toAccountId"] }
  )
  .refine((e) => e.type !== "pay_off_loan" || e.fromAccountId !== e.loanAccountId, {
    message: "The two accounts must differ",
    path: ["loanAccountId"],
  })
  .refine((e) => e.type !== "refinance" || e.cashOutAccountId !== e.loanAccountId, {
    message: "Cash taken out can't be deposited into the loan itself",
    path: ["cashOutAccountId"],
  })
  .refine((e) => e.type !== "open_loan" || e.proceedsAccountId !== e.loanAccountId, {
    message: "The borrowed money can't be deposited into the loan itself",
    path: ["proceedsAccountId"],
  })
  .refine((e) => e.type !== "roth_conversion" || e.amount != null || e.fillToBracketRate != null, {
    message: "Enter an amount, or choose a bracket to fill",
    path: ["amount"],
  });
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;
export type EventType = ScenarioEvent["type"];
