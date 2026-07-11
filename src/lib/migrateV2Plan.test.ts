import { describe, it, expect } from "vitest";
import { planSchema } from "@/domain";
import { forecastScenario } from "@/engine/forecastScenario";
import { looksLikeV2Plan, migrateV2PlanToV3 } from "./migrateV2Plan";

/**
 * Synthetic v2-shaped plan (fictional data, not derived from any real backup)
 * exercising every structural difference the migration needs to handle:
 * per-account routing fields, a fixed_split surplusRoutingRule, and all
 * four folded event types (income_change, expense_change, windfall,
 * social_security_start).
 */
function v2Plan() {
  return {
    id: "plan-1",
    activeScenarioId: "scenario-1",
    scenarios: [
      {
        id: "scenario-1",
        name: "Base Plan",
        household: { people: [{ id: "person-1", name: "Test", birthDate: "1990-01-01", retirementAge: 65, planningEndAge: 95 }] },
        accounts: [
          {
            id: "checking",
            name: "Checking",
            class: "cash",
            category: "asset",
            ownerId: null,
            startingBalance: 10_000,
            growthRatePct: 0.01,
            isExcluded: false,
            linkedExternally: true,
            withdrawalPriority: null,
            isSpendingAccount: true,
            targetCashBalance: 5_000,
            isSurplusTarget: false,
            surplusTargetPriority: null,
            maxBalance: null,
            maxBalanceGrowthRatePct: null,
            taxTreatment: "n/a",
            subjectToRMD: false,
          },
          {
            id: "savings",
            name: "Savings",
            class: "cash",
            category: "asset",
            ownerId: null,
            startingBalance: 5_000,
            growthRatePct: 0.02,
            isExcluded: false,
            withdrawalPriority: 1,
            isSpendingAccount: false,
            isSurplusTarget: true,
            surplusTargetPriority: 1,
            maxBalance: 20_000,
            maxBalanceGrowthRatePct: 0.03,
            taxTreatment: "n/a",
            subjectToRMD: false,
          },
          {
            id: "brokerage",
            name: "Brokerage",
            class: "taxable_investment",
            category: "asset",
            ownerId: null,
            startingBalance: 0,
            growthRatePct: 0.065,
            isExcluded: false,
            withdrawalPriority: 2,
            isSpendingAccount: false,
            isSurplusTarget: true,
            surplusTargetPriority: 2,
            maxBalance: null,
            maxBalanceGrowthRatePct: null,
            taxTreatment: "taxable",
            subjectToRMD: false,
          },
        ],
        incomeSources: [
          {
            id: "salary",
            name: "Salary",
            ownerId: "person-1",
            amount: 5_000,
            frequency: "monthly",
            startDate: "2026-01-01",
            endDate: null,
            growthRatePct: 0,
            depositAccountId: "checking",
            category: "salary",
          },
        ],
        expenses: [
          {
            id: "rent",
            name: "Rent",
            amount: 1_500,
            frequency: "monthly",
            startDate: "2026-01-01",
            endDate: null,
            growthRatePct: 0,
            paymentAccountId: "checking",
            category: "housing",
          },
        ],
        events: [
          {
            id: "career-break",
            type: "income_change",
            name: "Career break",
            startDate: "2026-06-01",
            endDate: "2026-08-31",
            targetIncomeSourceId: "salary",
            multiplier: 0,
          },
          {
            id: "rent-hike",
            type: "expense_change",
            name: "Rent goes up",
            startDate: "2026-07-01",
            targetExpenseId: "rent",
            multiplier: 1.1,
          },
          {
            id: "inheritance",
            type: "windfall",
            name: "Inheritance",
            startDate: "2026-03-01",
            amount: 20_000,
            depositAccountId: "brokerage",
          },
          {
            id: "car-repair",
            type: "windfall",
            name: "Car repair",
            startDate: "2026-04-01",
            amount: -3_000,
            depositAccountId: "checking",
          },
          {
            id: "ss-start",
            type: "social_security_start",
            name: "Social Security",
            startDate: "2026-05-01",
            personId: "person-1",
            monthlyBenefitAmount: 2_200,
            depositAccountId: "checking",
          },
        ],
        settings: {
          startDate: "2026-01-01",
          horizonEndDate: "2026-12-31",
          inflationRatePct: 0.03,
          defaultGrowthByClass: { cash: 0, taxable_investment: 0, tax_deferred: 0, tax_free: 0, real_estate: 0, other_asset: 0, credit_card: 0, loan: 0, mortgage: 0 },
          surplusRoutingRule: { mode: "priority_fill" },
          rmdEnabled: true,
          withdrawalTaxRates: { taxDeferredPct: 0.22, taxablePct: 0.15, taxFreePct: 0 },
        },
      },
    ],
  };
}

describe("looksLikeV2Plan", () => {
  it("detects the legacy shape", () => {
    expect(looksLikeV2Plan(v2Plan())).toBe(true);
  });

  it("does not flag an already-migrated (v3) plan", () => {
    const migrated = migrateV2PlanToV3(v2Plan());
    expect(looksLikeV2Plan(migrated)).toBe(false);
  });
});

describe("migrateV2PlanToV3", () => {
  // The migration operates on loosely-typed JSON pre-validation (see
  // migrateV2Plan.ts) -- assert on `any` here too, then separately confirm
  // the result actually satisfies planSchema (the real type contract).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const migrated = migrateV2PlanToV3(v2Plan()) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scenario: any = migrated.scenarios[0];

  it("produces a plan that validates against the current schema", () => {
    const result = planSchema.safeParse(migrated);
    expect(result.success).toBe(true);
  });

  it("translates per-account routing fields into settings.moneyFlow", () => {
    const mf = scenario.settings.moneyFlow;
    expect(mf.hubs).toEqual([{ accountId: "checking", bufferAmount: 5_000 }]);
    expect(mf.fillOrder.map((f: { accountId: string }) => f.accountId)).toEqual(["savings", "brokerage"]);
    expect(mf.fillOrder[0].maxBalance).toBe(20_000);
    expect(mf.fillOrder[0].maxBalanceGrowthRatePct).toBe(0.03);
    expect(mf.drainOrder).toEqual(["savings", "brokerage"]);
    expect(mf.splitMode).toBe("priority_fill");
  });

  it("folds income_change into an adjustment on the target income source", () => {
    const salary = scenario.incomeSources.find((i: { id: string }) => i.id === "salary");
    expect(salary.adjustments).toHaveLength(1);
    expect(salary.adjustments[0]).toMatchObject({ startDate: "2026-06-01", endDate: "2026-08-31", multiplier: 0 });
    expect(scenario.events.some((e: { type: string }) => e.type === "income_change")).toBe(false);
  });

  it("folds expense_change into an adjustment on the target expense", () => {
    const rent = scenario.expenses.find((e: { id: string }) => e.id === "rent");
    expect(rent.adjustments).toHaveLength(1);
    expect(rent.adjustments[0]).toMatchObject({ startDate: "2026-07-01", multiplier: 1.1 });
  });

  it("converts a positive windfall into an income source", () => {
    const inheritance = scenario.incomeSources.find((i: { name: string }) => i.name === "Inheritance");
    expect(inheritance).toBeDefined();
    expect(inheritance.amount).toBe(20_000);
    expect(inheritance.depositAccountId).toBe("brokerage");
    expect(inheritance.frequency).toBe("one_time");
  });

  it("converts a negative windfall into an expense", () => {
    const carRepair = scenario.expenses.find((e: { name: string }) => e.name === "Car repair");
    expect(carRepair).toBeDefined();
    expect(carRepair.amount).toBe(3_000);
    expect(carRepair.paymentAccountId).toBe("checking");
  });

  it("converts social_security_start into an income source with category social_security", () => {
    const ss = scenario.incomeSources.find((i: { id: string }) => i.id === "ss-start");
    expect(ss).toBeDefined();
    expect(ss.category).toBe("social_security");
    expect(ss.ownerId).toBe("person-1");
    expect(ss.amount).toBe(2_200);
    expect(ss.frequency).toBe("monthly");
    expect(ss.depositAccountId).toBe("checking");
    // No explicit growthRatePct on the old event -> falls back to the plan's inflation rate.
    expect(ss.growthRatePct).toBe(0.03);
  });

  it("removes all four folded event types, keeping nothing else changed", () => {
    expect(scenario.events).toHaveLength(0);
  });

  it("the migrated plan runs through the engine without error", () => {
    const parsed = planSchema.parse(migrated);
    const result = forecastScenario(parsed.scenarios[0]);
    expect(result.years.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.years[0].netWorthNominal)).toBe(true);
  });
});
