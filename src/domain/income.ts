import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";

export const incomeCategorySchema = z.enum([
  "salary",
  "social_security",
  "pension",
  "rental",
  "other",
]);
export type IncomeCategory = z.infer<typeof incomeCategorySchema>;

export const incomeSourceSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  ownerId: idSchema.nullable(),
  /** Per-occurrence amount, in today's dollars at startDate. */
  amount: z.number(),
  frequency: recurrenceFrequencySchema,
  startDate: isoDateSchema,
  /** null = continues to horizon unless an event ends it. */
  endDate: isoDateSchema.nullable(),
  /** Nominal (actual) annual growth rate -- already includes inflation. 0 = flat in nominal terms. */
  growthRatePct: z.number().default(0),
  depositAccountId: idSchema,
  category: incomeCategorySchema,
});
export type IncomeSource = z.infer<typeof incomeSourceSchema>;
