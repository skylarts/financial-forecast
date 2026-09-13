import { z } from "zod";
import { idSchema, isoDateSchema, recurrenceFrequencySchema } from "./common";
import { temporaryAdjustmentSchema } from "./adjustment";
import { dateAnchorFields } from "./anchor";

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
  /** Per-occurrence amount, in today's dollars at startDate. For salary,
   *  this is take-home pay (after tax withholding and pre-tax deductions --
   *  the model's historical assumption). */
  amount: z.number(),
  /**
   * Optional per-occurrence GROSS amount (in today's dollars, same basis as
   * `amount`) -- Box-1-style wages, after pre-tax deductions like a 401(k)
   * but before income tax withholding. Only meaningful for category="salary".
   * When set, it lets the engine stack capital gains and other-account
   * withdrawals on top of your true tax bracket while still working, instead
   * of assuming $0 other ordinary income during the accumulation years (see
   * forecastScenario.ts's federal-tax block). Omitted = engine behavior is
   * unchanged from before this field existed: salary contributes nothing to
   * bracket placement.
   */
  grossAmount: z.number().optional(),
  frequency: recurrenceFrequencySchema,
  startDate: isoDateSchema,
  /** null = continues to horizon unless adjusted below. */
  endDate: isoDateSchema.nullable(),
  ...dateAnchorFields,
  /** Nominal (actual) annual growth rate -- already includes inflation.
   *  0 = flat in nominal terms; null/omitted = match the plan's inflation rate. */
  growthRatePct: z.number().nullable().default(null),
  /** Repeat every N years (e.g. selling something on a cycle); overrides frequency. */
  intervalYears: z.number().int().positive().optional(),
  /** null = posts automatically to Extra Savings; set = explicit override (e.g. a windfall landing straight in a brokerage). */
  depositAccountId: idSchema.nullable(),
  category: incomeCategorySchema,
  /** Temporary scaling windows (a raise, a pause, a career break) -- see TemporaryAdjustment. */
  adjustments: z.array(temporaryAdjustmentSchema).optional(),
  /** Visible and editable, but the engine skips it entirely (no postings). */
  isExcluded: z.boolean().optional(),
  /**
   * Social Security / pension only: the age the benefit is claimed at. The
   * engine reads `startDate` (the owner's birthday at this age); this is
   * kept so the form can show the age that produced the date.
   */
  claimAge: z.number().positive().optional(),
  /**
   * Pension only: the share of the benefit that continues to a surviving
   * household member after the owner's modelled death (0..1). Omitted or 0
   * = the pension stops at death. Social Security has its own rule: the
   * survivor keeps whichever of the two benefits is larger.
   */
  survivorPct: z.number().min(0).max(1).optional(),
});
export type IncomeSource = z.infer<typeof incomeSourceSchema>;
