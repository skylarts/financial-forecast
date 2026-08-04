import type { Id, ISODate } from "./common";
import type { EventType } from "./events";
import type { Account, TaxTreatment } from "./account";

/**
 * Everything below is engine OUTPUT -- always freshly computed, never
 * loaded from disk as user input, so these are plain TS types rather than
 * Zod schemas (no untrusted external data to validate against them).
 */

/**
 * Whether a snapshot covers a calendar year or a single calendar month. The
 * engine emits both (see ProjectionResult.years / .months); every consumer
 * renders the two identically, since a period snapshot carries its own label.
 */
export type Granularity = "year" | "month";

export interface AccountPeriodRollforward {
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

/**
 * One signed contributor to the "Other account activity" reconciling line --
 * a down payment sourced from cash, home-sale proceeds landing on the hub, a
 * custom transfer touching the hub, or income deposited straight into a
 * non-hub account (negative: it counted in totalIncome but never reached
 * cash). Amounts are signed by their effect on cash; they sum exactly to
 * CashFlowPeriodRow.otherAccountActivity.
 */
export interface OtherActivityLineItem extends CashFlowLineItem {
  /** The non-hub counterparty account for this flow, when known (e.g. the home sold, the brokerage a windfall landed in); null for flows whose other leg isn't a single account. */
  accountId: Id | null;
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
  | "early_withdrawal_penalty"
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

/**
 * One period's cash flow. Every field below describes THIS period -- a
 * calendar year in `ProjectionResult.years`, a single month in
 * `ProjectionResult.months`. Both are built by the same code from the same
 * simulated numbers, so a year's twelve monthly rows sum exactly to its
 * annual row (see the monthly-rollup test).
 *
 * The one exception is the tax block at the bottom (federalTaxTotal,
 * federalTaxByComponent, ordinaryTaxableIncome, taxableSocialSecurityAmount):
 * the exact bracket-computed bill is only knowable once the year's income is
 * fully realized, so on monthly rows it lands entirely on DECEMBER and is
 * zero/empty for January-November. Withholding, by contrast, is taken at the
 * source as it happens and so is genuinely monthly.
 */
export interface CashFlowPeriodRow {
  /** The calendar year this period falls in (the year itself, for annual rows). */
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
   * Equals: operatingCashFlow - incomeTaxWithheldFromCash + withdrawalsToCashNet
   *         + taxSettlement - afterTaxContributionTotal - surplusRouted
   *         + cashInterest + otherAccountActivity.
   */
  netCashFlow: number;
  surplusRouted: number;
  /** Net (non-tax) cash pulled from accounts to cover the operating gap -- deficit draws + RMDs. */
  withdrawalsToCashNet: number;
  rmdTotal: number;
  /** Total tax realized on all account withdrawals this year (part of each withdrawal's gross). */
  withdrawalTaxes: number;
  /**
   * Year-end tax true-up posted to the spending hub: taxes withheld during
   * the year minus the exact bracket-computed bill. Positive = refund into
   * cash (the estimated withholding over-collected), negative = additional
   * tax paid from cash. Guarantees the household's actual cash tax for the
   * year equals federalTaxTotal exactly.
   */
  taxSettlement: number;
  /** Estimated tax withheld from Social Security / pension deposits that landed on the hub (reduces cash). */
  incomeTaxWithheldFromCash: number;
  /** Interest/growth earned directly on the spending hub balance this year. */
  cashInterest: number;
  /**
   * Edge-case reconciling residual: transfers that land on/leave the hub
   * directly (a custom transfer or a down payment sourced from checking), net
   * of income that bypassed the hub entirely (e.g. a windfall deposited
   * straight into a brokerage). Zero in the common case.
   */
  otherAccountActivity: number;
  /** Itemized breakdown of otherAccountActivity -- each contributing flow, labeled, signed by its effect on cash; sums exactly to otherAccountActivity. */
  otherActivityByItem: OtherActivityLineItem[];
  /** Total balance across every class="cash" account (Extra Savings, checking, an emergency fund, etc.), not just the spending hub -- a broader, display-only figure than netCashFlow/cashInterest above, which stay scoped to the hub for an exact reconcile. */
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
 *
 * `surplus_route` (a hub sweeping cash to a fill target) and `cap_overflow`
 * (a fill target over its ceiling spilling to the next stop) are logged too:
 * both are engine-initiated, and without them a routing loop between two
 * accounts is invisible in the output.
 */
export interface LedgerEvent {
  date: ISODate;
  kind:
    | "rmd"
    | "deficit_withdrawal"
    | "mortgage_payment"
    | "surplus_route"
    | "cap_overflow"
    | "tax_settlement"
    | "home_sale"
    /** A bill aimed at one account exceeded its balance: the account was left at
     *  exactly $0 and the remainder charged to the hub for the drain order to
     *  cover. `accountId` is the hub the money came from, `toAccountId` the
     *  emptied account whose bill it paid. */
    | "shortfall_spill";
  accountId: Id;
  toAccountId?: Id;
  amount: number;
  note: string;
}

/**
 * One period of the simulation, as of its last day: a calendar year (in
 * `ProjectionResult.years`) or a single month (in `ProjectionResult.months`).
 * Both granularities carry identical fields, so a table or chart can render
 * either without knowing which it was handed -- use `periodLabel` for column
 * headers and `periodKey` for React keys rather than reading `year`.
 */
export interface PeriodSnapshot {
  granularity: Granularity;
  /** Unique, sortable key for this period: "2026" (annual) or "2026-03" (monthly). */
  periodKey: string;
  /** Human column header: "2026" (annual) or "Mar '26" (monthly). */
  periodLabel: string;
  /** The calendar year this period falls in (the year itself, for annual rows). */
  year: number;
  /** Last day of the period -- Dec 31 for a year, month-end for a month. */
  date: ISODate;
  totalAssetsNominal: number;
  totalLiabilitiesNominal: number;
  netWorthNominal: number;
  /** Nominal deflated by cumulative inflation back to start-date dollars. */
  netWorthReal: number;
  /** (1+inflation)^(years elapsed from the plan start through the LAST DAY of this period).
   *  Divide an end-of-period BALANCE by this to show it in today's dollars. */
  inflationDeflator: number;
  /** (1+inflation)^(years elapsed from the plan start to the MIDPOINT of this period) --
   *  the right deflator for FLOWS (income/expenses/withdrawals occur throughout the
   *  period, so on average at its midpoint), vs. inflationDeflator for closing balances. */
  flowInflationDeflator: number;
  accountBalances: Record<Id, number>;
  rollforwards: AccountPeriodRollforward[];
  cashFlow: CashFlowPeriodRow;
}

export interface ProjectionWarning {
  year: number;
  kind:
    | "insufficient_funds"
    | "unlinked_mortgage"
    | "routing_conflict"
    | "early_withdrawal_penalty"
    | "unamortized_debt"
    /** An account was drawn all the way to $0 and something it was funding had
     *  to be covered by the withdrawal routing instead. Informational, not
     *  necessarily a problem -- it's the expected end state of deliberately
     *  spending an account down (a 529, say). */
    | "account_depleted";
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
  /** One snapshot per calendar year, for the whole horizon. */
  years: PeriodSnapshot[];
  /**
   * One snapshot per MONTH, for the first `MONTHLY_DETAIL_YEARS` plan years
   * only -- the window the monthly drill-down views can show. Deliberately
   * bounded: a 50-year horizon at monthly resolution is 600 columns of data
   * nobody reads, and the near-term months are the ones worth inspecting
   * (an upcoming purchase, a year with lumpy annual bills).
   */
  months: PeriodSnapshot[];
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
