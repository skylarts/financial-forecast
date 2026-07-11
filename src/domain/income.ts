import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";
import { temporaryAdjustmentSchema } from "./adjustment";

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
  /** null = continues to horizon unless adjusted below. */
  endDate: isoDateSchema.nullable(),
  /** Nominal (actual) annual growth rate -- already includes inflation. 0 = flat in nominal terms. */
  growthRatePct: z.number().default(0),
  /** Repeat every N years (e.g. selling something on a cycle); overrides frequency. */
  intervalYears: z.number().int().positive().optional(),
  depositAccountId: idSchema,
  category: incomeCategorySchema,
  /** Temporary scaling windows (a raise, a pause, a career break) -- see TemporaryAdjustment. */
  adjustments: z.array(temporaryAdjustmentSchema).optional(),
  /** Visible and editable, but the engine skips it entirely (no postings). */
  isExcluded: z.boolean().optional(),
});
export type IncomeSource = z.infer<typeof incomeSourceSchema>;
