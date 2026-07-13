import { nanoid } from "nanoid";
import type { Account, AccountClass, Scenario, ScenarioEvent, IncomeSource, ExpenseBaseline, MoneyFlow } from "@/domain";

/**
 * Legacy-shaped convenience hints for building a test account's cash-flow
 * role. These fields no longer exist on Account (see settings.moneyFlow) --
 * makeAccount/makeScenario translate them into the real moneyFlow shape so
 * the many existing engine tests didn't need a mechanical rewrite when the
 * routing model moved off the account object.
 */
interface MoneyFlowHints {
  isSpendingAccount?: boolean;
  targetCashBalance?: number | null;
  withdrawalPriority?: number | null;
  isSurplusTarget?: boolean;
  surplusTargetPriority?: number | null;
  maxBalance?: number | null;
  maxBalanceGrowthRatePct?: number | null;
}

export type TestAccount = Account & MoneyFlowHints;

export function makeAccount(overrides: Partial<Account> & MoneyFlowHints & { class: AccountClass }): TestAccount {
  const category = overrides.category ?? (["credit_card", "loan", "mortgage"].includes(overrides.class) ? "liability" : "asset");
  const {
    isSpendingAccount,
    targetCashBalance,
    withdrawalPriority,
    isSurplusTarget,
    surplusTargetPriority,
    maxBalance,
    maxBalanceGrowthRatePct,
    ...accountOverrides
  } = overrides;
  const account: Account = {
    id: nanoid(),
    name: "Account",
    ownerId: null,
    startingBalance: 0,
    growthRatePct: 0,
    isExcluded: false,
    taxTreatment: "n/a",
    subjectToRMD: false,
    ...accountOverrides,
    category,
  };
  return {
    ...account,
    isSpendingAccount,
    targetCashBalance,
    withdrawalPriority,
    isSurplusTarget,
    surplusTargetPriority,
    maxBalance,
    maxBalanceGrowthRatePct,
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

/** Derives settings.moneyFlow from the legacy per-account hints on `accounts`. */
function deriveMoneyFlow(
  accounts: TestAccount[],
  surplusRoutingRule?: { mode: "priority_fill" } | { mode: "fixed_split"; splits: { accountId: string; pct: number }[] }
): MoneyFlow {
  const hubs = accounts
    .filter((a) => a.isSpendingAccount)
    .map((a) => ({ accountId: a.id, bufferAmount: a.targetCashBalance ?? null }));
  const fillOrder = accounts
    .filter((a) => a.isSurplusTarget)
    .sort((a, b) => (a.surplusTargetPriority ?? 0) - (b.surplusTargetPriority ?? 0))
    .map((a) => ({
      accountId: a.id,
      maxBalance: a.maxBalance ?? null,
      maxBalanceGrowthRatePct: a.maxBalanceGrowthRatePct ?? null,
      splitPct:
        surplusRoutingRule?.mode === "fixed_split"
          ? surplusRoutingRule.splits.find((s) => s.accountId === a.id)?.pct ?? null
          : null,
    }));
  const drainOrder = accounts
    .filter((a) => a.withdrawalPriority != null)
    .sort((a, b) => (a.withdrawalPriority as number) - (b.withdrawalPriority as number))
    .map((a) => ({ id: nanoid(), accountId: a.id, startDate: null, endDate: null, splitPct: null }));
  return {
    hubs,
    fillOrder,
    drainOrder,
    fillSplitMode: surplusRoutingRule?.mode ?? "priority_fill",
    drainSplitMode: "priority_fill",
  };
}

const MONEY_FLOW_HINT_KEYS = [
  "isSpendingAccount",
  "targetCashBalance",
  "withdrawalPriority",
  "isSurplusTarget",
  "surplusTargetPriority",
  "maxBalance",
  "maxBalanceGrowthRatePct",
] as const satisfies readonly (keyof MoneyFlowHints)[];

/** Strips the test-only money-flow hints back off, leaving a real Account. */
function cleanAccount(a: TestAccount): Account {
  const account = { ...a };
  for (const key of MONEY_FLOW_HINT_KEYS) delete account[key];
  return account;
}

export function makeScenario(overrides: {
  accounts: TestAccount[];
  incomeSources?: IncomeSource[];
  expenses?: ExpenseBaseline[];
  events?: ScenarioEvent[];
  startDate?: string;
  horizonEndDate?: string;
  inflationRatePct?: number;
  people?: Scenario["household"]["people"];
  filingStatus?: Scenario["settings"]["filingStatus"];
  additionalFlatTaxRatePct?: number;
  surplusRoutingRule?: { mode: "priority_fill" } | { mode: "fixed_split"; splits: { accountId: string; pct: number }[] };
  moneyFlow?: MoneyFlow;
}): Scenario {
  return {
    id: nanoid(),
    name: "Test Scenario",
    household: { people: overrides.people ?? [{ id: nanoid(), name: "Test Person", birthDate: "1960-01-01", retirementAge: 65, planningEndAge: 95 }] },
    accounts: overrides.accounts.map(cleanAccount),
    incomeSources: overrides.incomeSources ?? [],
    expenses: overrides.expenses ?? [],
    events: overrides.events ?? [],
    settings: {
      startDate: overrides.startDate ?? "2026-01-01",
      horizonEndDate: overrides.horizonEndDate ?? "2026-12-31",
      inflationRatePct: overrides.inflationRatePct ?? 0,
      moneyFlow: overrides.moneyFlow ?? deriveMoneyFlow(overrides.accounts, overrides.surplusRoutingRule),
      rmdEnabled: true,
      filingStatus: overrides.filingStatus ?? "marriedFilingJointly",
      additionalFlatTaxRatePct: overrides.additionalFlatTaxRatePct ?? 0,
    },
  };
}
