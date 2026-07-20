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
      /** Nominal annual growth rate, already includes inflation. 0 = flat in nominal terms. */
      growthRatePct: z.number().default(0),
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
  purchasePrice: z.number().positive(),
  downPaymentAmount: z.number().nonnegative(),
  /** Financed: funds the down payment. Cash: funds the whole purchase price. */
  downPaymentFromAccountId: idSchema,
  propertyGrowthRatePct: z.number(),
  /** null = paid in cash, no liability created. */
  mortgage: z
    .object({
      annualInterestRatePct: z.number().min(0).max(1),
      termMonths: z.number().int().positive(),
      /** Extra principal paid each month on top of the scheduled payment. */
      extraPrincipalMonthly: z.number().nonnegative().optional(),
    })
    .nullable(),
  /** Annual property tax as a fraction of the home's (growing) value, e.g. 0.01 = 1%/yr. */
  propertyTaxRatePct: z.number().nonnegative().optional(),
  /** Annual home insurance as a fraction of the home's (growing) value, e.g. 0.005 = 0.5%/yr. */
  homeInsuranceRatePct: z.number().nonnegative().optional(),
  /** Annual maintenance as a fraction of the home's (growing) value, e.g. 0.01 = 1%/yr -- the classic "1% rule" upkeep estimate. */
  maintenanceRatePct: z.number().nonnegative().optional(),
  /** When true, any Expense with category "housing" stops the day before this
   *  purchase closes -- the old rent/mortgage payment it's replacing. */
  replaceHousingExpenses: z.boolean().optional(),
});
export type BuyHomeEvent = z.infer<typeof buyHomeEventSchema>;

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
  growthRatePct: z.number().optional(),
  /** Repeat every N years (e.g. a car replaced every 7 yrs); overrides frequency. */
  intervalYears: z.number().int().positive().optional(),
});
export type CustomTransferEvent = z.infer<typeof customTransferEventSchema>;

export const scenarioEventSchema = z
  .discriminatedUnion("type", [
    retireEventSchema,
    buyHomeEventSchema,
    haveAKidEventSchema,
    customTransferEventSchema,
  ])
  .refine((e) => e.type !== "custom_transfer" || e.fromAccountId !== e.toAccountId, {
    message: "fromAccountId and toAccountId must differ",
    path: ["toAccountId"],
  });
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;
export type EventType = ScenarioEvent["type"];
