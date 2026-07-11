import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";

const baseEventFields = {
  id: idSchema,
  name: z.string().min(1),
  startDate: isoDateSchema,
  /** For temporary effects (career break); omitted/null = permanent. */
  endDate: isoDateSchema.nullable().optional(),
  notes: z.string().optional(),
};

export const retireEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("retire"),
  personId: idSchema,
  /** Overrides Person.retirementAge if provided. */
  retirementAge: z.number().int().positive().optional(),
});
export type RetireEvent = z.infer<typeof retireEventSchema>;

export const incomeChangeEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("income_change"),
  /** The existing income source this modifies ("career break", ad hoc raise/cut). To add a
   *  new income source, use "+ Add Income" on the Income & Expenses tab instead -- it already
   *  supports a future start date, so there's no separate "new source" path here. */
  targetIncomeSourceId: idSchema,
  /** e.g. 0 = full pause, 0.5 = half-time, applied over [startDate, endDate]. */
  multiplier: z.number().min(0).optional(),
});
export type IncomeChangeEvent = z.infer<typeof incomeChangeEventSchema>;

export const expenseChangeEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("expense_change"),
  /** The existing expense this modifies. To add a new expense, use "+ Add Expense" on the
   *  Income & Expenses tab instead -- it already supports a future start date. */
  targetExpenseId: idSchema,
  multiplier: z.number().min(0).optional(),
});
export type ExpenseChangeEvent = z.infer<typeof expenseChangeEventSchema>;

export const buyHomeEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("buy_home"),
  purchasePrice: z.number().positive(),
  downPaymentAmount: z.number().nonnegative(),
  downPaymentFromAccountId: idSchema,
  propertyGrowthRatePct: z.number(),
  /** null = paid in cash, no liability created. */
  mortgage: z
    .object({
      annualInterestRatePct: z.number().min(0).max(1),
      termMonths: z.number().int().positive(),
    })
    .nullable(),
});
export type BuyHomeEvent = z.infer<typeof buyHomeEventSchema>;

export const socialSecurityStartEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("social_security_start"),
  personId: idSchema,
  /** Today's dollars; grown each year by `growthRatePct` as a COLA. */
  monthlyBenefitAmount: z.number().nonnegative(),
  /** Annual COLA; defaults to the global inflation rate when unset. */
  growthRatePct: z.number().optional(),
  depositAccountId: idSchema,
});
export type SocialSecurityStartEvent = z.infer<typeof socialSecurityStartEventSchema>;

export const haveAKidEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("have_a_kid"),
  childcareMonthlyExpense: z.number().nonnegative(),
  childcareEndDate: isoDateSchema.nullable(),
  additionalOneTimeCost: z.number().nonnegative().optional(),
  paymentAccountId: idSchema,
});
export type HaveAKidEvent = z.infer<typeof haveAKidEventSchema>;

export const windfallEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("windfall"),
  /** Positive = inflow, negative = one-time outflow. */
  amount: z.number(),
  depositAccountId: idSchema,
  isRecurring: z.boolean().optional(),
  frequency: recurrenceFrequencySchema.optional(),
  /** Repeat every N years (e.g. a car replaced every 7 yrs); overrides frequency. */
  intervalYears: z.number().int().positive().optional(),
});
export type WindfallEvent = z.infer<typeof windfallEventSchema>;

export const growthRateChangeEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("growth_rate_change"),
  targetAccountId: idSchema,
  /** Replaces the account's growthRatePct (or propertyGrowthRatePct for real estate) from startDate on. */
  newGrowthRatePct: z.number(),
});
export type GrowthRateChangeEvent = z.infer<typeof growthRateChangeEventSchema>;

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
    incomeChangeEventSchema,
    expenseChangeEventSchema,
    buyHomeEventSchema,
    socialSecurityStartEventSchema,
    haveAKidEventSchema,
    windfallEventSchema,
    customTransferEventSchema,
    growthRateChangeEventSchema,
  ])
  .refine((e) => e.type !== "custom_transfer" || e.fromAccountId !== e.toAccountId, {
    message: "fromAccountId and toAccountId must differ",
    path: ["toAccountId"],
  });
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;
export type EventType = ScenarioEvent["type"];
