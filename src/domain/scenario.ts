import { z } from "zod";
import { nanoid } from "nanoid";
import { idSchema } from "./common";
import { householdSchema } from "./household";
import { accountSchema, type Account } from "./account";
import { incomeSourceSchema } from "./income";
import { expenseBaselineSchema } from "./expense";
import { scenarioEventSchema } from "./events";
import { forecastSettingsSchema } from "./settings";

function freshExtraSavingsAccount(): Account {
  return {
    id: nanoid(),
    name: "Extra Savings",
    class: "cash",
    category: "asset",
    ownerId: null,
    startingBalance: 0,
    growthRatePct: 0,
    taxTreatment: "n/a",
    subjectToRMD: false,
    isExtraSavings: true,
  };
}

export const scenarioSchema = z
  .object({
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
  })
  .transform((scenario) => {
    // Extra Savings is mandatory: every scenario has exactly one, the sole
    // account the engine sweeps surplus into and drains from -- see
    // forecastScenario.ts. Auto-inject one here so this holds for every
    // scenario that ever passes through .parse(), including old plans saved
    // before this concept existed (no separate migration step needed).
    if (scenario.accounts.some((a) => a.isExtraSavings)) return scenario;
    return { ...scenario, accounts: [freshExtraSavingsAccount(), ...scenario.accounts] };
  });
export type Scenario = z.infer<typeof scenarioSchema>;

/** Top-level persisted document. */
export const planSchema = z.object({
  id: idSchema,
  scenarios: z.array(scenarioSchema).min(1),
  activeScenarioId: idSchema,
});
export type Plan = z.infer<typeof planSchema>;
