import { z } from "zod";
import { idSchema, isoDateSchema } from "./common";

/**
 * A temporary scaling window directly on an income source or expense --
 * replaces the old separate income_change / expense_change event types
 * (v2). Folding this onto the entity itself removes a whole class of
 * "which event points at which income source" indirection: a career break,
 * a temporary rent hike, or a one-off raise is just an attribute of the
 * income/expense it affects, not a standalone event referencing it by id.
 */
export const temporaryAdjustmentSchema = z.object({
  id: idSchema,
  startDate: isoDateSchema,
  /** null/omitted = runs through the end of the plan. */
  endDate: isoDateSchema.nullable().optional(),
  /** e.g. 0 = full pause, 0.5 = half, 1.03 = a one-off 3% bump. */
  multiplier: z.number().min(0),
  note: z.string().optional(),
});
export type TemporaryAdjustment = z.infer<typeof temporaryAdjustmentSchema>;
