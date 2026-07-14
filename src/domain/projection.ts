import type { Id, ISODate } from "./common";
import type { EventType } from "./events";
import type { Account, TaxTreatment } from "./account";

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
  /** The date this item first posted anywhere in the plan (its real start date, since months are simulated in order); null if never posted. */
  startDate: ISODate | null;
}

/** A contribution line, tagged by how it's funded for cash-flow treatment. */
export interface ContributionLineItem extends CashFlowLineItem {
  /** Payroll-deducted contributions are excluded from take-home, so they don't reduce cash flow. */
  fromPaycheck: boolean;
}

/**
 * One source account's total outflow for the year, from ANY mechanism --
 * planned drawdowns (deficit cascade), RMDs, and money paid/transferred
 * directly out of the account. `gross` is what left the account; `net` is the
 * usable portion (funded spending or landed in cash); `tax` is what the
 * withdrawal cost in tax. Invariant: gross = net + tax.
 */
export interface WithdrawalLineItem {
  /** Source account id. */
  id: Id;
  label: string;
  /** For grouping the withdrawals section (Cash & Other / Taxable / Tax-deferred / Tax-free). */
  taxTreatment: TaxTreatment;
  gross: number;
  net: number;
  tax: number;
}

export type FederalTaxComponentKey =
  | "tax_deferred"
  | "pension"
  | "taxable_social_security"
  | "capital_gains"
  | "state_local";

/**
 * One component of the year's exact federal tax bill, allocated pro-rata by
 * gross-income share for the ordinary-tax components (tax_deferred/pension/
 * taxable_social_security), plus capital_gains and state_local computed
 * directly. Zero-amount components are omitted; the remaining amounts still
 * sum exactly to federalTaxTotal.
 */
export interface FederalTaxComponent {
  key: FederalTaxComponentKey;
  label: string;
  amount: number;
}

export interface CashFlowYearRow {
  year: number;
  totalIncome: number;
  totalExpenses: number;
  /** Income - Expenses, before any money is moved into or out of accounts. */
  operatingCashFlow: number;
  /**
   * The actual measured change in cash-on-hand (the spending hub balance)
   * this year -- always exactly right by construction (it's the real
   * simulated balance delta, not a sum of categorized buckets). Lands near
   * zero when you draw exactly what you need (the buffer is maintained).
   * Equals: operatingCashFlow + withdrawalsToCashNet - afterTaxContributionTotal
   *         - surplusRouted + cashInterest + otherAccountActivity.
   */
  netCashFlow: number;
  surplusRouted: number;
  /** Net (non-tax) cash pulled from accounts to cover the operating gap -- deficit draws + RMDs. */
  withdrawalsToCashNet: number;
  rmdTotal: number;
  /** Total tax realized on all account withdrawals this year (part of each withdrawal's gross). */
  withdrawalTaxes: number;
  /** Interest/growth earned directly on the spending hub balance this year. */
  cashInterest: number;
  /**
   * Edge-case reconciling residual: transfers that land on/leave the hub
   * directly (a custom transfer or a down payment sourced from checking), net
   * of income that bypassed the hub entirely (e.g. a windfall deposited
   * straight into a brokerage). Zero in the common case.
   */
  otherAccountActivity: number;
  /** The spending hub account balance (not every class="cash" account -- a savings/emergency-fund account is a withdrawal source, not operating cash). */
  endingCashBalance: number;
  /** Cash outflow from after-tax contributions (money saved into accounts). */
  afterTaxContributionTotal: number;
  /** Itemized positive inflows; sums to totalIncome. */
  incomeByItem: CashFlowLineItem[];
  /** Itemized positive outflows incl. mortgage payments; sums to totalExpenses. */
  expenseByItem: CashFlowLineItem[];
  /** All contributions (pre- and after-tax) by account. */
  contributionsByItem: ContributionLineItem[];
  /** Surplus swept INTO accounts, by destination account (positive-cash-flow years). */
  surplusByAccount: CashFlowLineItem[];
  /**
   * Every account outflow for the year -- drawdowns, RMDs, and direct
   * payments/transfers out -- with gross/net/tax, keyed by source account.
   * The comprehensive "Withdrawals (Planned, RMDs & taxes)" view.
   */
  withdrawalsByAccount: WithdrawalLineItem[];
  /**
   * The exact federal tax bill for the year, computed from real 2026 IRS
   * brackets (inflated forward) on realized income -- NOT a sum of the
   * approximate per-withdrawal `tax` figures above, which only size
   * withholding during the simulation. Includes the optional flat state/local
   * add-on from settings.additionalFlatTaxRatePct (0 by default).
   */
  federalTaxTotal: number;
  /** federalTaxTotal broken into its sources (tax-deferred/RMD withdrawals, pension, taxable SS, capital gains, state/local add-on); sums exactly to federalTaxTotal. */
  federalTaxByComponent: FederalTaxComponent[];
  /** Ordinary taxable income for the year (tax-deferred withdrawals + gross pension + taxable Social Security, net of the standard deduction). */
  ordinaryTaxableIncome: number;
  /** Realized long-term capital gains from taxable-account withdrawals this year (gain-over-basis portion only). */
  capitalGainsRealized: number;
  /** Gross (pre-tax) Social Security benefits received this year. */
  grossSocialSecurity: number;
  /** The taxable portion of grossSocialSecurity, per the IRS provisional-income rule. */
  taxableSocialSecurityAmount: number;
}

export interface TimelineRow {
  eventId: Id;
  eventType: EventType;
  name: string;
  date: ISODate;
  year: number;
  description: string;
  /** Excluded events still show here (with a badge) but have no engine effect. */
  isExcluded?: boolean;
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
  kind: "insufficient_funds" | "unlinked_mortgage";
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
