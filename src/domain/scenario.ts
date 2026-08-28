import { z } from "zod";
import { nanoid } from "nanoid";
import { idSchema } from "./common";
import { householdSchema } from "./household";
import { accountSchema, type Account } from "./account";
import { incomeSourceSchema } from "./income";
import { expenseBaselineSchema } from "./expense";
import { scenarioEventSchema } from "./events";
import { forecastSettingsSchema, type MoneyFlow } from "./settings";

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

/**
 * Balance bounds used to live on the routing stops (splitStop.maxBalance,
 * drainStop.minBalance); they now live on the account, because they govern the
 * balance no matter which rule moved the money. Lift any legacy values onto
 * their accounts and clear them off the stops, so an already-saved plan keeps
 * behaving identically without a separate migration step -- same approach as
 * the Extra Savings auto-inject above.
 *
 * First stop to mention an account wins: the old schema allowed the same
 * account in several stops with different bounds, which an account-level bound
 * can't express. Taking the first (highest-priority) one keeps the tightest
 * rule the user actually saw take effect in most plans, and the alternative --
 * silently picking the max or min -- would change behavior more surprisingly.
 */
function migrateStopBoundsToAccounts<
  T extends { accounts: Account[]; settings: { moneyFlow: MoneyFlow } },
>(scenario: T): T {
  const { splitOrder, drainOrder } = scenario.settings.moneyFlow;
  const hasLegacy =
    splitOrder.some((s) => s.maxBalance != null) || drainOrder.some((s) => s.minBalance != null);
  if (!hasLegacy) return scenario;

  const ceilings = new Map<string, Pick<Account, "balanceCeiling" | "balanceCeilingGrowthRatePct">>();
  for (const stop of splitOrder) {
    if (stop.maxBalance == null || ceilings.has(stop.accountId)) continue;
    ceilings.set(stop.accountId, {
      balanceCeiling: stop.maxBalance,
      balanceCeilingGrowthRatePct: stop.maxBalanceGrowthRatePct,
    });
  }
  const floors = new Map<string, Pick<Account, "balanceFloor" | "balanceFloorGrowthRatePct">>();
  for (const stop of drainOrder) {
    if (stop.minBalance == null || floors.has(stop.accountId)) continue;
    floors.set(stop.accountId, {
      balanceFloor: stop.minBalance,
      balanceFloorGrowthRatePct: stop.minBalanceGrowthRatePct,
    });
  }

  return {
    ...scenario,
    accounts: scenario.accounts.map((account) => {
      const ceiling = ceilings.get(account.id);
      const floor = floors.get(account.id);
      if (!ceiling && !floor) return account;
      // An explicit bound already on the account wins -- it was set against
      // the current schema, so it's newer than anything left on a stop.
      return {
        ...account,
        ...(ceiling && account.balanceCeiling == null ? ceiling : {}),
        ...(floor && account.balanceFloor == null ? floor : {}),
      };
    }),
    settings: {
      ...scenario.settings,
      moneyFlow: {
        splitOrder: splitOrder.map((s) => ({ ...s, maxBalance: null, maxBalanceGrowthRatePct: null })),
        drainOrder: drainOrder.map((s) => ({ ...s, minBalance: null, minBalanceGrowthRatePct: null })),
      },
    },
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
  })
  .transform(migrateStopBoundsToAccounts);
export type Scenario = z.infer<typeof scenarioSchema>;

/** Top-level persisted document. */
export const planSchema = z.object({
  id: idSchema,
  scenarios: z.array(scenarioSchema).min(1),
  activeScenarioId: idSchema,
});
export type Plan = z.infer<typeof planSchema>;
