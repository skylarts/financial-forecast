import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";

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
});
export type RetireEvent = z.infer<typeof retireEventSchema>;

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
