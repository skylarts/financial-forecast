import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";
import { temporaryAdjustmentSchema } from "./adjustment";

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
  /** null = pays automatically from Extra Savings; set = explicit override (e.g. paid straight out of an investment). */
  paymentAccountId: idSchema.nullable(),
  category: expenseCategorySchema,
  /** Temporary scaling windows (a spending cut, a temporary rent hike). */
  adjustments: z.array(temporaryAdjustmentSchema).optional(),
  /** Visible and editable, but the engine skips it entirely (no postings). */
  isExcluded: z.boolean().optional(),
});
export type ExpenseBaseline = z.infer<typeof expenseBaselineSchema>;
