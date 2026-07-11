import { nanoid } from "nanoid";
import type { Account, AccountClass, Scenario, ScenarioEvent, IncomeSource, ExpenseBaseline } from "@/domain";

const defaultGrowthByClass: Record<AccountClass, number> = {
  cash: 0,
  taxable_investment: 0,
  tax_deferred: 0,
  tax_free: 0,
  real_estate: 0,
  other_asset: 0,
  credit_card: 0,
  loan: 0,
  mortgage: 0,
};

export function makeAccount(overrides: Partial<Account> & { class: AccountClass }): Account {
  const category = overrides.category ?? (["credit_card", "loan", "mortgage"].includes(overrides.class) ? "liability" : "asset");
  return {
    id: nanoid(),
    name: "Account",
    ownerId: null,
    startingBalance: 0,
    growthRatePct: 0,
    isExcluded: false,
    linkedExternally: false,
    withdrawalPriority: null,
    isSpendingAccount: false,
    isSurplusTarget: false,
    surplusTargetPriority: null,
    maxBalance: null,
    maxBalanceGrowthRatePct: null,
    taxTreatment: "n/a",
    subjectToRMD: false,
    ...overrides,
    category,
  };
}

export function makeIncome(overrides: Partial<IncomeSource> & { depositAccountId: string }): IncomeSource {
  return {
    id: nanoid(),
    name: "Income",
    ownerId: null,
    amount: 0,
    frequency: "monthly",
    startDate: "2026-01-01",
    endDate: null,
    growthRatePct: 0,
    category: "salary",
    ...overrides,
  };
}

export function makeExpense(overrides: Partial<ExpenseBaseline> & { paymentAccountId: string }): ExpenseBaseline {
  return {
    id: nanoid(),
    name: "Expense",
    amount: 0,
    frequency: "monthly",
    startDate: "2026-01-01",
    endDate: null,
    growthRatePct: 0,
    category: "other",
    ...overrides,
  };
}

export function makeScenario(overrides: {
  accounts: Account[];
  incomeSources?: IncomeSource[];
  expenses?: ExpenseBaseline[];
  events?: ScenarioEvent[];
  startDate?: string;
  horizonEndDate?: string;
  inflationRatePct?: number;
  people?: Scenario["household"]["people"];
  withdrawalTaxRates?: Scenario["settings"]["withdrawalTaxRates"];
  surplusRoutingRule?: Scenario["settings"]["surplusRoutingRule"];
}): Scenario {
  return {
    id: nanoid(),
    name: "Test Scenario",
    household: { people: overrides.people ?? [{ id: nanoid(), name: "Test Person", birthDate: "1960-01-01", retirementAge: 65, planningEndAge: 95 }] },
    accounts: overrides.accounts,
    incomeSources: overrides.incomeSources ?? [],
    expenses: overrides.expenses ?? [],
    events: overrides.events ?? [],
    settings: {
      startDate: overrides.startDate ?? "2026-01-01",
      horizonEndDate: overrides.horizonEndDate ?? "2026-12-31",
      inflationRatePct: overrides.inflationRatePct ?? 0,
      defaultGrowthByClass,
      surplusRoutingRule: overrides.surplusRoutingRule ?? { mode: "priority_fill" },
      rmdEnabled: true,
      // Untaxed by default so existing tests stay deterministic; opt in per test.
      withdrawalTaxRates: overrides.withdrawalTaxRates ?? { taxDeferredPct: 0, taxablePct: 0, taxFreePct: 0 },
    },
  };
}
