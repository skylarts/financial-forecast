import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";

export const expenseCategorySchema = z.enum([
  "housing",
  "transportation",
  "food",
  "healthcare",
  "childcare",
  "discretionary",
  "other",
]);
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

export const expenseBaselineSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  amount: z.number(),
  frequency: recurrenceFrequencySchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable(),
  /** Nominal (actual) annual growth rate -- already includes inflation. 0 = flat in nominal terms. */
  growthRatePct: z.number().default(0),
  /** Repeat every N years (e.g. a car replaced every 7 yrs); overrides frequency. */
  intervalYears: z.number().int().positive().optional(),
  /** Direct assignment -- mirrors the validated "pay from a specific account" pattern. */
  paymentAccountId: idSchema,
  category: expenseCategorySchema,
});
export type ExpenseBaseline = z.infer<typeof expenseBaselineSchema>;
