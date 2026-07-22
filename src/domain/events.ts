import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";
import { temporaryAdjustmentSchema } from "./adjustment";

const baseEventFields = {
  id: idSchema,
  name: z.string().min(1),
  startDate: isoDateSchema,
  /** For temporary effects (career break); omitted/null = permanent. */
  endDate: isoDateSchema.nullable().optional(),
  notes: z.string().optional(),
  /** Visible and editable, but the engine skips it entirely -- no effect on
   *  the projection. A lighter-weight "what if this didn't happen" toggle
   *  than duplicating a whole scenario. */
  isExcluded: z.boolean().optional(),
};

export const retireEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("retire"),
  personId: idSchema,
  /** Overrides Person.retirementAge if provided. */
  retirementAge: z.number().int().positive().optional(),
  /** Optional recurring annual expense that starts the day retirement begins
   *  (extra travel, hobbies, etc.) -- same today's-dollars + growth-rate +
   *  temporary-adjustment shape as a regular Expense, just anchored to this
   *  event's startDate instead of its own. */
  retirementExpense: z
    .object({
      amount: z.number().nonnegative(),
      /** Nominal annual growth rate, already includes inflation.
       *  0 = flat in nominal terms; null/omitted = match the plan's inflation rate. */
      growthRatePct: z.number().nullable().default(null),
      /** null = pays automatically from Extra Savings. */
      paymentAccountId: idSchema.nullable(),
      /** null/omitted = runs through the end of the plan. */
      endDate: isoDateSchema.nullable().optional(),
      /** Temporary scaling windows (e.g. a few extra years of travel budget). */
      adjustments: z.array(temporaryAdjustmentSchema).optional(),
    })
    .nullable()
    .optional(),
});
export type RetireEvent = z.infer<typeof retireEventSchema>;

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

export const haveAKidEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("have_a_kid"),
  childcareMonthlyExpense: z.number().nonnegative(),
  childcareEndDate: isoDateSchema.nullable(),
  additionalOneTimeCost: z.number().nonnegative().optional(),
  paymentAccountId: idSchema,
});
export type HaveAKidEvent = z.infer<typeof haveAKidEventSchema>;

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
    retireEventSchema,
    buyHomeEventSchema,
    sellHomeEventSchema,
    haveAKidEventSchema,
    customTransferEventSchema,
  ])
  .refine((e) => e.type !== "custom_transfer" || e.fromAccountId !== e.toAccountId, {
    message: "fromAccountId and toAccountId must differ",
    path: ["toAccountId"],
  });
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;
export type EventType = ScenarioEvent["type"];
