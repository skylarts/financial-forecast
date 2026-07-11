import { z } from "zod";
import { idSchema } from "./common";
import { householdSchema } from "./household";
import { accountSchema } from "./account";
import { incomeSourceSchema } from "./income";
import { expenseBaselineSchema } from "./expense";
import { scenarioEventSchema } from "./events";
import { forecastSettingsSchema } from "./settings";

export const scenarioSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** Provenance only -- never consulted at calculation time. See DESIGN.md Ambiguity #1. */
  createdFromScenarioId: idSchema.optional(),
  household: householdSchema,
  accounts: z.array(accountSchema),
  incomeSources: z.array(incomeSourceSchema),
  expenses: z.array(expenseBaselineSchema),
  events: z.array(scenarioEventSchema),
  settings: forecastSettingsSchema,
});
export type Scenario = z.infer<typeof scenarioSchema>;

/** Top-level persisted document. */
export const planSchema = z.object({
  id: idSchema,
  scenarios: z.array(scenarioSchema).min(1),
  activeScenarioId: idSchema,
});
export type Plan = z.infer<typeof planSchema>;
