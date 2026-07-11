import type { Id, ISODate } from "./common";
import type { EventType } from "./events";
import type { Account } from "./account";

/**
 * Everything below is engine OUTPUT -- always freshly computed, never
 * loaded from disk as user input, so these are plain TS types rather than
 * Zod schemas (no untrusted external data to validate against them).
 */

export interface AccountYearRollforward {
  accountId: Id;
  year: number;
  startingBalance: number;
  inflationAdjustment: number;
  growth: number;
  deposits: number;
  withdrawals: number;
  endingBalance: number;
}

/** One row in the per-item income/expense breakdown for a given year. */
export interface CashFlowLineItem {
  /** Stable grouping key (income source / expense / event / mortgage / account id). */
  id: Id;
  label: string;
  amount: number;
}

/** A contribution line, tagged by how it's funded for cash-flow treatment. */
export interface ContributionLineItem extends CashFlowLineItem {
  /** Payroll-deducted contributions are excluded from take-home, so they don't reduce cash flow. */
  fromPaycheck: boolean;
}

export interface CashFlowYearRow {
  year: number;
  totalIncome: number;
  totalExpenses: number;
  /** income - (expenses + after-tax contributions). */
  netCashFlow: number;
  surplusRouted: number;
  deficitCovered: number;
  rmdTotal: number;
  /** Taxes paid on retirement-account withdrawals & RMDs this year (cash out). */
  withdrawalTaxes: number;
  endingCashBalance: number;
  /** Cash outflow from after-tax contributions (feeds netCashFlow). */
  afterTaxContributionTotal: number;
  /** Itemized positive inflows; sums to totalIncome. */
  incomeByItem: CashFlowLineItem[];
  /** Itemized positive outflows incl. mortgage payments; sums to totalExpenses. */
  expenseByItem: CashFlowLineItem[];
  /** All contributions (pre- and after-tax) by account. */
  contributionsByItem: ContributionLineItem[];
  /** Surplus swept INTO accounts, by destination account (positive-cash-flow years). */
  surplusByAccount: CashFlowLineItem[];
  /** Shortfall draws pulled FROM accounts, by source account (negative-cash-flow years). */
  withdrawalsByAccount: CashFlowLineItem[];
  /** Forced RMD draws, by source account. */
  rmdByAccount: CashFlowLineItem[];
}

export interface TimelineRow {
  eventId: Id;
  eventType: EventType;
  name: string;
  date: ISODate;
  year: number;
  description: string;
}

/**
 * Itemized log of engine-driven money movements that aren't user-authored
 * events -- RMDs, deficit-cascade withdrawals, and mortgage payments. This
 * is what the "Automatic Withdrawals & RMDs" panel in the prior build
 * surfaced; kept as a first-class output here rather than only exposing
 * year-level totals, since it's the kind of detail that made the RMD/cascade
 * behavior legible and trustworthy there.
 */
export interface LedgerEvent {
  date: ISODate;
  kind: "rmd" | "deficit_withdrawal" | "mortgage_payment";
  accountId: Id;
  toAccountId?: Id;
  amount: number;
  note: string;
}

export interface YearSnapshot {
  year: number;
  date: ISODate;
  totalAssetsNominal: number;
  totalLiabilitiesNominal: number;
  netWorthNominal: number;
  /** Nominal deflated by cumulative inflation back to start-date dollars. */
  netWorthReal: number;
  /** (1+inflation)^(year-startYear). Divide any nominal dollar by this to show it in today's dollars. */
  inflationDeflator: number;
  accountBalances: Record<Id, number>;
  rollforwards: AccountYearRollforward[];
  cashFlow: CashFlowYearRow;
}

export interface ProjectionWarning {
  year: number;
  kind: "insufficient_funds" | "unlinked_mortgage" | "balance_update_required" | "other";
  message: string;
  accountId?: Id;
}

export interface ProjectionResult {
  scenarioId: Id;
  computedAt: string;
  /**
   * The full resolved account list, including ones created by events (e.g.
   * a buy_home event's real estate + mortgage accounts). Superset of
   * Scenario.accounts -- UI code that renders balances/rollforwards should
   * use this, not Scenario.accounts directly, or event-created accounts
   * won't have names/classes to render against.
   */
  accounts: Account[];
  years: YearSnapshot[];
  timeline: TimelineRow[];
  ledger: LedgerEvent[];
  kpis: {
    netWorthEndOfYear1: number;
    netWorthEndOfYear1Real: number;
    netWorthAtRetirement: number | null;
    netWorthAtRetirementReal: number | null;
    retirementAge: number | null;
    netWorthAtEnd: number;
    netWorthAtEndReal: number;
  };
  warnings: ProjectionWarning[];
}
