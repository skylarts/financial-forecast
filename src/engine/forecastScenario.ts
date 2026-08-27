import type {
  Id,
  ISODate,
  Scenario,
  AccountPeriodRollforward,
  CashFlowPeriodRow,
  FederalTaxComponent,
  Granularity,
  PeriodSnapshot,
  ProjectionResult,
  ProjectionWarning,
  LedgerEvent,
  SplitStop,
  DrainStop,
  FlowLimitPeriod,
} from "@/domain";
import {
  addMonths,
  ageOn,
  compareDates,
  eachMonthStart,
  elapsedYears,
  endOfMonth,
  endOfYear,
  midMonth,
  monthColumnLabel,
  todayISO,
  yearOf,
  yearMonthOf,
} from "./dateMath";
import { monthlyRateFromAnnual } from "./growth";
import { rmdDivisor, rmdStartAgeForBirthYear } from "./rmd";
import { computeMonthlyPayment, amortizeMonth } from "./amortization";
import { resolveEvents } from "./resolveEvents";
import { resolvePrimarySpendingAccountId } from "./moneyFlow";
import type { EngineAccount, MortgageSpec, Posting } from "./types";
import {
  bracketsForYear,
  marginalRate,
  progressiveTax,
  stackedLtcgTax,
  standardDeductionForYear,
  taxableSocialSecurity,
  ZERO_TAX_RATES,
  SEED_TAX_RATES,
  type YearTaxRates,
} from "./taxTables";

interface YearAccumulator {
  rollforward: Map<Id, { growth: number; deposits: number; withdrawals: number }>;
  totalIncome: number;
  totalExpenses: number;
  surplusRouted: number;
  /** Net (non-tax) cash pulled to cover the operating gap: deficit draws + RMD proceeds. */
  deficitCovered: number;
  rmdTotal: number;
  /**
   * Net (non-tax) amount paid/transferred DIRECTLY out of a non-hub asset
   * account for an expense (bypassing cash). Offsets that expense in the net
   * cash-flow reconciliation, since cash was never touched. Almost always 0.
   */
  directExpenseFromAccounts: number;
  /**
   * Income deposited DIRECTLY into a non-hub account (e.g. a windfall landing
   * straight in a brokerage) -- still counted in totalIncome for the itemized
   * display, but never reached cash on hand, so it's subtracted back out when
   * reconciling. Almost always 0.
   */
  directIncomeToOtherAccounts: number;
  /**
   * Net signed amount of transfer-category postings (custom_transfer, a
   * buy_home down payment) that land ON or come FROM a hub account directly
   * -- positive = into the hub, negative = out. The only posting category not
   * otherwise captured by income/expense/contribution/withdrawal tracking.
   */
  hubTransferNet: number;
  /**
   * Signed per-flow contributions to the "Other account activity" line --
   * every increment to hubTransferNet and every subtraction via
   * directIncomeToOtherAccounts, keyed by a stable per-flow id. Sums exactly
   * to hubTransferNet - directIncomeToOtherAccounts.
   */
  otherActivityByItem: Map<Id, number>;
  /** Taxes paid on RMDs and shortfall withdrawals (cash leaving the household). */
  taxesPaid: number;
  /**
   * The December true-up posted to the hub (withheld minus the exact bill).
   * Lives on the accumulator rather than as a local so the monthly snapshot
   * for December picks it up in its diff like every other flow -- otherwise
   * the twelve monthly rows wouldn't sum to the annual row.
   */
  taxSettlement: number;
  /** Portion of taxesPaid that was withheld from SS/pension deposits landing ON the hub (needed for the hub-scoped reconcile). */
  incomeWithheldFromHub: number;
  /** 10% early-withdrawal penalties charged on pre-59½ tax-deferred withdrawals (part of taxesPaid). */
  earlyWithdrawalPenalties: number;
  /** Cash outflow from after-tax contributions (reduces net cash flow). */
  afterTaxContributions: number;
  /** Positive per-source inflows, keyed by Posting.sourceId. */
  incomeByItem: Map<Id, number>;
  /** Positive per-source outflows (incl. mortgage payments), keyed by source/account id. */
  expenseByItem: Map<Id, number>;
  /** Gross contribution amounts deposited, keyed by `${accountId}:contribution`. */
  contributionsByItem: Map<Id, number>;
  /** Surplus swept into each target account, keyed by accountId. */
  surplusByAccount: Map<Id, number>;
  /** Net (non-tax) outflow from each source account -- ALL mechanisms, keyed by accountId. */
  withdrawalNetByAccount: Map<Id, number>;
  /** Tax realized per source account, matching withdrawalNetByAccount. */
  withdrawalTaxByAccount: Map<Id, number>;
  /** Realized capital gains (not the whole withdrawal, just the gain-over-basis portion) from taxable-account draws. */
  capitalGainsRealized: number;
  /** Gross (pre-tax) Social Security benefits received this year. */
  grossSocialSecurity: number;
  /** Gross (pre-tax) pension income received this year -- fully ordinary-taxable, no partial-inclusion rule. */
  grossPension: number;
  /**
   * Gross (Box-1-style) salary this year, from income sources that opted in
   * via IncomeSource.grossAmount -- 0 for any source that didn't. Used only
   * to place withdrawals/pension/SS/capital-gains in the correct tax bracket
   * during working years (salary itself is never taxed by this engine; see
   * the federal-tax block's stacking math).
   */
  grossSalary: number;
}

function freshAccumulator(accountIds: Id[]): YearAccumulator {
  return {
    rollforward: new Map(accountIds.map((id) => [id, { growth: 0, deposits: 0, withdrawals: 0 }])),
    totalIncome: 0,
    totalExpenses: 0,
    surplusRouted: 0,
    deficitCovered: 0,
    rmdTotal: 0,
    directExpenseFromAccounts: 0,
    directIncomeToOtherAccounts: 0,
    hubTransferNet: 0,
    otherActivityByItem: new Map(),
    taxesPaid: 0,
    taxSettlement: 0,
    incomeWithheldFromHub: 0,
    earlyWithdrawalPenalties: 0,
    afterTaxContributions: 0,
    incomeByItem: new Map(),
    expenseByItem: new Map(),
    contributionsByItem: new Map(),
    surplusByAccount: new Map(),
    withdrawalNetByAccount: new Map(),
    withdrawalTaxByAccount: new Map(),
    capitalGainsRealized: 0,
    grossSocialSecurity: 0,
    grossPension: 0,
    grossSalary: 0,
  };
}

function addTo(map: Map<Id, number>, key: Id, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/**
 * How many plan years get month-by-month snapshots (see
 * ProjectionResult.months). Bounded on purpose: the monthly views exist to
 * inspect near-term detail -- an upcoming purchase, a year with lumpy annual
 * bills -- and a 50-year horizon at monthly resolution is 600 columns nobody
 * reads. The annual snapshots always cover the full horizon.
 */
export const MONTHLY_DETAIL_YEARS = 5;

type RollforwardBucket = { growth: number; deposits: number; withdrawals: number };

/**
 * Deep copy of the accumulator (numbers by value, every Map and bucket
 * freshly allocated), taken at the start of each month so the month's own
 * activity can be recovered by differencing against it at month end.
 */
function cloneAccumulator(a: YearAccumulator): YearAccumulator {
  const out = { ...a } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(a)) {
    if (key === "rollforward") {
      out[key] = new Map([...(value as Map<Id, RollforwardBucket>)].map(([id, b]) => [id, { ...b }]));
    } else if (value instanceof Map) {
      out[key] = new Map(value as Map<Id, number>);
    }
  }
  return out as unknown as YearAccumulator;
}

/**
 * `after - before`, field by field -- the activity that happened between the
 * two snapshots. This is what makes monthly rows possible without touching
 * the ~40 sites that accumulate into the year: every field here is additive,
 * so a diff of two accumulator states IS a valid accumulator covering just
 * that span, and can be fed straight into the same period builder the annual
 * path uses. Walks the object generically, so a new accumulator field is
 * picked up automatically rather than silently missing from monthly rows.
 */
function diffAccumulator(before: YearAccumulator, after: YearAccumulator): YearAccumulator {
  const prev = before as unknown as Record<string, unknown>;
  const out = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(after)) {
    if (typeof value === "number") {
      out[key] = value - (prev[key] as number);
    } else if (key === "rollforward") {
      const priorBuckets = prev[key] as Map<Id, RollforwardBucket>;
      const next = new Map<Id, RollforwardBucket>();
      for (const [id, bucket] of value as Map<Id, RollforwardBucket>) {
        const p = priorBuckets.get(id) ?? { growth: 0, deposits: 0, withdrawals: 0 };
        next.set(id, {
          growth: bucket.growth - p.growth,
          deposits: bucket.deposits - p.deposits,
          withdrawals: bucket.withdrawals - p.withdrawals,
        });
      }
      out[key] = next;
    } else {
      // Every remaining field is a Map<Id, number> of per-item totals. Entries
      // that didn't move this period are dropped so a monthly row lists only
      // the items that actually posted in it.
      const priorTotals = prev[key] as Map<Id, number>;
      const next = new Map<Id, number>();
      for (const [id, total] of value as Map<Id, number>) {
        const delta = total - (priorTotals.get(id) ?? 0);
        if (Math.abs(delta) > 0.005) next.set(id, delta);
      }
      out[key] = next;
    }
  }
  return out as unknown as YearAccumulator;
}

function effectiveAnnualRate(account: EngineAccount, month: string, inflationRatePct: number): number {
  // A growthRateSchedule entry overrides everything else once it's started --
  // pick the last one (by startDate) that has begun as of this month.
  const overrides = account.growthRateOverrides;
  if (overrides?.length) {
    let active: number | undefined;
    for (const o of overrides) {
      if (compareDates(o.startDate, month) > 0) break;
      active = o.growthRatePct;
    }
    if (active !== undefined) return active;
  }
  if (account.class === "real_estate" && account.propertyGrowthRatePct !== undefined) {
    return account.propertyGrowthRatePct;
  }
  // A blank (null) growth rate means "keep pace with the plan's inflation
  // assumption" -- the app-wide convention for every growth-rate input.
  return account.growthRatePct ?? inflationRatePct;
}

/** Whether a drain stop's optional date window covers this month (both bounds inclusive; null = unbounded). */
function isDrainStopActive(stop: DrainStop, month: ISODate): boolean {
  if (stop.startDate && compareDates(month, stop.startDate) < 0) return false;
  if (stop.endDate && compareDates(month, stop.endDate) > 0) return false;
  return true;
}

/** Mirrors isDrainStopActive: whether a split stop's optional date window covers this month. */
function isSplitStopActive(stop: SplitStop, month: ISODate): boolean {
  if (stop.startDate && compareDates(month, stop.startDate) < 0) return false;
  if (stop.endDate && compareDates(month, stop.endDate) > 0) return false;
  return true;
}

/**
 * The most this account should hold in a given year. Uncapped accounts return
 * Infinity (they absorb everything). Capped ones grow their ceiling yearly by
 * balanceCeilingGrowthRatePct, defaulting to inflation, so the bound keeps
 * pace in real terms over a long horizon.
 *
 * Reads the ACCOUNT, not the routing stop: the ceiling holds however the money
 * arrived -- routed surplus, a direct transfer, income deposited straight in,
 * or the account's own growth (see the cap-overflow step).
 */
function effectiveBalanceCeiling(account: EngineAccount, yearsSinceStart: number, inflationRatePct: number): number {
  if (account.balanceCeiling == null) return Infinity;
  const rate = account.balanceCeilingGrowthRatePct ?? inflationRatePct;
  return account.balanceCeiling * Math.pow(1 + rate, Math.max(0, yearsSinceStart));
}

/** Mirrors effectiveBalanceCeiling, so a drain floor stays a "today's dollars" amount. */
function effectiveBalanceFloor(account: EngineAccount, yearsSinceStart: number, inflationRatePct: number): number {
  if (account.balanceFloor == null) return 0;
  const rate = account.balanceFloorGrowthRatePct ?? inflationRatePct;
  return account.balanceFloor * Math.pow(1 + rate, Math.max(0, yearsSinceStart));
}

/** An unset limitPeriod means annual -- the common case (a yearly contribution room). */
function limitPeriodOf(stop: { limitPeriod?: FlowLimitPeriod }): FlowLimitPeriod {
  return stop.limitPeriod ?? "annual";
}

/**
 * The bucket a month falls into for a stop's rate limit. Every period is a
 * whole number of months (see flowLimitPeriodSchema), so the key is derivable
 * from the month cursor alone -- no separate calendar state to keep in sync.
 */
function flowLimitPeriodKey(period: FlowLimitPeriod, month: ISODate): string {
  const year = month.slice(0, 4);
  if (period === "annual") return year;
  if (period === "monthly") return month.slice(0, 7);
  const quarter = Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}

/** A stop's rate limit for the current period, in that year's dollars; Infinity when unset. */
function effectiveFlowLimit(
  stop: { limitAmount?: number | null; limitGrowthRatePct?: number | null },
  yearsSinceStart: number,
  inflationRatePct: number
): number {
  if (stop.limitAmount == null) return Infinity;
  const rate = stop.limitGrowthRatePct ?? inflationRatePct;
  return stop.limitAmount * Math.pow(1 + rate, Math.max(0, yearsSinceStart));
}

/**
 * How a withdrawal from this account is taxed. Prefers the explicit
 * taxTreatment, but falls back to the account class when it's left at "n/a"
 * (default) -- so a brokerage / traditional / Roth account is taxed correctly
 * even if the user never set the treatment field.
 */
/**
 * Whether the simulation has reached an account's creation month yet.
 * `month` (the loop's cursor, from eachMonthStart) is always the 1st of a
 * calendar month, but `effectiveStartDate` can land on any day -- comparing
 * them as exact dates would treat the account as "not started" for its
 * entire creation month whenever that date isn't the 1st (e.g. a plan start
 * of "today" almost never is), silently dropping its starting balance.
 * Compare by month instead, matching the month-level equality check
 * (`isCreationMonth`) used right after this to actually seed the balance.
 */
function hasReachedStartMonth(month: ISODate, effectiveStartDate: ISODate): boolean {
  return month.slice(0, 7) >= effectiveStartDate.slice(0, 7);
}

function effectiveTaxTreatment(account: EngineAccount): "taxable" | "tax_deferred" | "tax_free" | "n/a" {
  if (account.taxTreatment !== "n/a") return account.taxTreatment;
  switch (account.class) {
    case "taxable_investment":
      return "taxable";
    case "tax_deferred":
      return "tax_deferred";
    case "tax_free":
      return "tax_free";
    default:
      return "n/a";
  }
}

/**
 * Runs one deterministic month-by-month simulation of the scenario. Low-level
 * and single-pass -- `ratesByYearOverride` supplies the per-year marginal
 * tax-rate ESTIMATES used to size withholding/gross-up during the monthly
 * loop (omit it, as most engine tests do, and every year is untaxed). The
 * exact, bracket-computed tax bill for each year (`cashFlow.federalTaxTotal`)
 * is always calculated fresh at year-end regardless of the estimate's
 * accuracy -- see `projectScenario` below, which iterates this function to
 * converge the estimates onto the real numbers before returning.
 */
export function forecastScenario(scenario: Scenario, ratesByYearOverride?: Map<number, YearTaxRates>): ProjectionResult {
  // A null startDate means "today, live" (see forecastSettingsSchema) --
  // resolved once here so every other read of settings.startDate below can
  // keep treating it as a plain, always-present date.
  const settings = { ...scenario.settings, startDate: scenario.settings.startDate ?? todayISO() };
  const moneyFlow = settings.moneyFlow;
  const ratesForYear = (year: number): YearTaxRates => ratesByYearOverride?.get(year) ?? ZERO_TAX_RATES;
  const resolved = resolveEvents(scenario);
  const accounts = resolved.accounts;
  const accountIds = accounts.map((a) => a.id);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const incomeSourceById = new Map(scenario.incomeSources.map((s) => [s.id, s]));
  // Excluded accounts stay in the resolved list (so the UI can still render
  // them as a static line) but are skipped everywhere in the simulation: no
  // growth, no postings, no RMDs, no routing, no totals. Their balance simply
  // freezes at startingBalance once set.
  const activeAccounts = accounts.filter((a) => !a.isExcluded);

  const postingsByMonth = new Map<string, Posting[]>();
  for (const p of resolved.postings) {
    const list = postingsByMonth.get(p.yearMonth) ?? [];
    list.push(p);
    postingsByMonth.set(p.yearMonth, list);
  }

  const mortgagePayments = new Map<Id, number>();
  for (const m of resolved.mortgages) {
    mortgagePayments.set(
      m.accountId,
      m.loanTerms.monthlyPayment ??
        computeMonthlyPayment(m.loanTerms.originalPrincipal, m.loanTerms.annualInterestRatePct, m.loanTerms.termMonths)
    );
  }
  const mortgageByAccountId = new Map<Id, MortgageSpec>(resolved.mortgages.map((m) => [m.accountId, m]));

  // Resolve the money-flow waterfall against the actual (active) accounts:
  // Extra Savings is the sole hub (see resolvePrimarySpendingAccountId and
  // scenarioSchema's auto-inject transform), splitOrder is the ordered
  // surplus-target chain, drainOrder is the ordered deficit cascade. List
  // order IS the priority -- no numeric priority fields anywhere.
  const primarySpendingAccountId = resolvePrimarySpendingAccountId(activeAccounts);
  const extraSavingsAccount = primarySpendingAccountId ? accountById.get(primarySpendingAccountId) : undefined;
  // Split targets must be assets -- surplus "deposited" into a liability
  // would corrupt its amount-owed balance (mirrors the drainStops filter).
  const splitStops = moneyFlow.splitOrder
    .map((stop) => {
      const account = accountById.get(stop.accountId);
      return account && account.category === "asset" && !account.isExcluded ? { account, stop } : null;
    })
    .filter((x): x is { account: EngineAccount; stop: SplitStop } => x !== null);
  const drainStops = moneyFlow.drainOrder
    .map((stop) => {
      const account = accountById.get(stop.accountId);
      return account && account.category === "asset" && !account.isExcluded ? { account, stop } : null;
    })
    .filter((x): x is { account: EngineAccount; stop: DrainStop } => x !== null);

  // ---------------------------------------------------------------------
  // Per-stop rate limits. A stop's limitAmount bounds how much may move
  // THROUGH THAT RULE per limitPeriod -- distinct from the target/source
  // account's balanceCeiling/balanceFloor, which bound the resulting balance.
  // Both are enforced, whichever binds first: a rate limit can't see the
  // balance (left alone it would drain straight through a floor), and a bound
  // can't see the speed.
  //
  // Keyed by stop id, not account id, so the same account appearing in two
  // stops with different windows gets an independent allowance for each --
  // the phased-drawdown pattern drainStopSchema is built around. Usage resets
  // whenever the period key changes rather than on an explicit calendar
  // boundary, so a mid-plan gap in months can't strand a stale allowance.
  // ---------------------------------------------------------------------
  const flowLimitUsage = new Map<Id, { periodKey: string; used: number }>();
  const remainingFlowLimit = (
    stop: SplitStop | DrainStop,
    month: ISODate,
    yearsSinceStart: number
  ): number => {
    const limit = effectiveFlowLimit(stop, yearsSinceStart, settings.inflationRatePct);
    if (limit === Infinity) return Infinity;
    const periodKey = flowLimitPeriodKey(limitPeriodOf(stop), month);
    const usage = flowLimitUsage.get(stop.id);
    const used = usage && usage.periodKey === periodKey ? usage.used : 0;
    return Math.max(0, limit - used);
  };
  const recordFlowUse = (stop: SplitStop | DrainStop, month: ISODate, amount: number): void => {
    if (stop.limitAmount == null || amount <= 0) return;
    const periodKey = flowLimitPeriodKey(limitPeriodOf(stop), month);
    const usage = flowLimitUsage.get(stop.id);
    const used = usage && usage.periodKey === periodKey ? usage.used : 0;
    flowLimitUsage.set(stop.id, { periodKey, used: used + amount });
  };

  // Outflows from Extra Savings are ordinary expenses; outflows from any
  // OTHER asset account (checking, savings, an investment) are "withdrawals"
  // for the Cash Flow tab's Withdrawals section -- checking is no longer a
  // privileged hub, so a directed expense paid straight from it now reports
  // as a withdrawal like any other account, and "cash on hand" means Extra
  // Savings' balance specifically, not checking's.
  const hubIds = new Set<Id>(extraSavingsAccount ? [extraSavingsAccount.id] : []);
  // All active "cash" accounts (Extra Savings, checking, an emergency fund,
  // etc.), used only for the "cash on hand" figure shown on the Cash Flow
  // tab -- broader than hubIds, which stays scoped to Extra Savings alone
  // for withdrawal/transfer categorization elsewhere in this function.
  const cashAccountIds = new Set<Id>(activeAccounts.filter((a) => a.class === "cash").map((a) => a.id));

  const balances = new Map<Id, number>(accounts.map((a) => [a.id, 0]));
  // Cost basis for taxable_investment accounts (average-cost method -- no
  // per-lot tracking): starting balance + every dollar of new money that's
  // landed in the account since (contributions, routed surplus, rebalanced
  // transfers). Growth never touches it. Only read for "taxable"-treatment
  // accounts; harmless bookkeeping for everything else.
  const basis = new Map<Id, number>(accounts.map((a) => [a.id, 0]));
  const priorYearEndBalances = new Map<Id, number>();

  const years: PeriodSnapshot[] = [];
  // Monthly snapshots for the drill-down window only (see MONTHLY_DETAIL_YEARS).
  const months: PeriodSnapshot[] = [];
  const monthlyDetailThrough = endOfMonth(yearMonthOf(addMonths(settings.startDate, MONTHLY_DETAIL_YEARS * 12 - 1)));
  const ledger: LedgerEvent[] = [];
  const warnings: ProjectionWarning[] = [];
  const warnedThisYear = new Set<string>(); // `${year}:${accountId}`
  // Display names for the per-item cash-flow breakdown, keyed by Posting.sourceId
  // (and mortgage account id). Stable across the whole run.
  const itemLabels = new Map<Id, string>();
  // The date each item FIRST posted anywhere in the plan -- its real start
  // date, since months are simulated in chronological order. Set once, never
  // overwritten, so a recurring item keeps its true first occurrence.
  const itemFirstDate = new Map<Id, ISODate>();
  const markFirstDate = (id: Id, date: ISODate) => {
    if (!itemFirstDate.has(id)) itemFirstDate.set(id, date);
  };
  // Whether each contribution line is payroll-deducted (excluded from cash
  // flow) vs funded from take-home, keyed by sourceId.
  const contributionFromPaycheck = new Map<Id, boolean>();
  // Counterparty account for each "Other account activity" line (the home
  // sold, the brokerage a windfall landed in), keyed by the same per-flow id
  // as acc.otherActivityByItem; null when the other leg isn't a single
  // known account. Stable across the whole run, like itemLabels.
  const otherActivityAccountId = new Map<Id, Id | null>();

  let currentYear = yearOf(settings.startDate);
  // The month being simulated -- advanced at the top of the loop so the
  // withdrawal-tax helpers below (defined once, used every month) can do
  // age-dependent checks like the pre-59½ early-withdrawal penalty.
  let currentMonth: ISODate = settings.startDate;
  let acc = freshAccumulator(accountIds);
  const yearStartBalances = new Map<Id, number>(balances);

  // Record one signed contribution to the "Other account activity" line.
  // Called at EVERY site that touches hubTransferNet or
  // directIncomeToOtherAccounts, with the same signed amount that flows into
  // the scalar -- so the items always sum exactly to the total.
  const recordOtherActivity = (id: Id, label: string, counterpartyId: Id | null, amount: number, date: ISODate): void => {
    addTo(acc.otherActivityByItem, id, amount);
    itemLabels.set(id, label);
    markFirstDate(id, date);
    if (!otherActivityAccountId.has(id)) otherActivityAccountId.set(id, counterpartyId);
  };

  const personById = new Map(scenario.household.people.map((p) => [p.id, p]));
  const EARLY_WITHDRAWAL_PENALTY_RATE = 0.1;
  /** 10% penalty applies to a tax-deferred withdrawal when the owner is under 59½ and the account isn't flagged exempt (72(t) / rule of 55). */
  const earlyWithdrawalPenaltyRate = (account: EngineAccount): number => {
    if (account.noEarlyWithdrawalPenalty) return 0;
    if (effectiveTaxTreatment(account) !== "tax_deferred") return 0;
    const owner = account.ownerId ? personById.get(account.ownerId) : undefined;
    if (!owner) return 0; // jointly-held/unowned: no age to test against
    return elapsedYears(owner.birthDate, currentMonth) < 59.5 ? EARLY_WITHDRAWAL_PENALTY_RATE : 0;
  };

  // New money landing in a taxable_investment account (a contribution, a
  // routed surplus sweep, a rebalanced transfer) is basis, not gain --
  // called at every credit site for such an account.
  const creditBasisIfTaxable = (accountId: Id, amount: number): void => {
    if (amount <= 0) return;
    const account = accountById.get(accountId);
    if (account && effectiveTaxTreatment(account) === "taxable") {
      basis.set(accountId, (basis.get(accountId) ?? 0) + amount);
    }
  };

  // The rate used to size a withdrawal BEFORE any balance mutation (the
  // deficit cascade needs this to know how much it can safely pull without
  // overdrawing once tax is realized). For a taxable account this is the
  // gain fraction of the CURRENT (pre-withdrawal) balance times the LTCG
  // rate, since only the gain portion is ever taxed.
  const estimatedWithdrawalRate = (account: EngineAccount): number => {
    const treatment = effectiveTaxTreatment(account);
    const rates = ratesForYear(currentYear);
    if (treatment === "tax_deferred") return rates.ordinaryMarginalRate + earlyWithdrawalPenaltyRate(account);
    if (treatment === "taxable") {
      const bal = balances.get(account.id) ?? 0;
      const bas = basis.get(account.id) ?? 0;
      const gainFraction = bal > 0 ? Math.max(0, bal - bas) / bal : 0;
      return gainFraction * rates.ltcgMarginalRate;
    }
    return 0;
  };

  // Single source of truth for withdrawal tax. Any time `amount` leaves a
  // taxable / tax-deferred account -- a transfer or sale out of it, an RMD, a
  // draw to cover spending, a cap-overflow rebalance -- that sale realizes
  // tax, deducted from the same account and tallied on the "Taxes on
  // withdrawals & RMDs" cash-flow line. Cash and Roth realize no tax. A
  // tax-deferred withdrawal is taxed in full (ordinary income, no basis
  // concept); a taxable-account withdrawal is taxed only on its realized-gain
  // portion (average-cost basis, reduced proportionally). Deposits and moving
  // *cash* into investments are never taxed. Note: `balances.get(sourceId)`
  // is already net of `amount` at every call site below, so gain-fraction
  // math reconstructs the pre-withdrawal balance as `balance + amount`.
  const realizeWithdrawalTax = (sourceId: Id, amount: number): number => {
    if (amount <= 0) return 0;
    const src = accountById.get(sourceId);
    if (!src) return 0;
    const treatment = effectiveTaxTreatment(src);
    const rates = ratesForYear(currentYear);
    let tax = 0;
    if (treatment === "tax_deferred") {
      tax = amount * rates.ordinaryMarginalRate;
      // 10% early-withdrawal penalty before the owner turns 59½ -- charged
      // at the source like the ordinary-income withholding, counted in the
      // exact year-end bill (see federalTaxByComponent), and surfaced as a
      // once-per-year warning so it never silently drains a retire-early plan.
      const penaltyRate = earlyWithdrawalPenaltyRate(src);
      if (penaltyRate > 0) {
        const penalty = amount * penaltyRate;
        tax += penalty;
        acc.earlyWithdrawalPenalties += penalty;
        const warnKey = `${currentYear}:penalty:${src.id}`;
        if (!warnedThisYear.has(warnKey)) {
          warnedThisYear.add(warnKey);
          warnings.push({
            year: currentYear,
            kind: "early_withdrawal_penalty",
            accountId: src.id,
            message: `${src.name}: 10% early-withdrawal penalty applied before age 59½ (starting ${currentMonth}). Consider a Roth/taxable bridge, 72(t), or the rule of 55.`,
          });
        }
      }
    } else if (treatment === "taxable") {
      const balBefore = (balances.get(sourceId) ?? 0) + amount;
      const bas = basis.get(sourceId) ?? 0;
      const gainFraction = balBefore > 0 ? Math.max(0, balBefore - bas) / balBefore : 0;
      const gain = amount * gainFraction;
      const basisPortion = balBefore > 0 ? amount * (bas / balBefore) : 0;
      basis.set(sourceId, Math.max(0, bas - basisPortion));
      acc.capitalGainsRealized += gain;
      tax = gain * rates.ltcgMarginalRate;
    }
    if (tax <= 0) return 0;
    balances.set(sourceId, (balances.get(sourceId) ?? 0) - tax);
    const bucket = acc.rollforward.get(sourceId);
    if (bucket) bucket.withdrawals += tax;
    acc.taxesPaid += tax;
    return tax;
  };

  // Pulls up to `requested` from `source` to cover `spender`'s shortfall,
  // capped by what's actually available once the draw's own tax is realized
  // (provide <= available / (1 + rate), same as the tax realized on any
  // other withdrawal). `floor` (default 0) keeps this source's balance from
  // being drawn below that amount -- the remaining shortfall is left for the
  // caller to spill to the next source. Returns the net (non-tax) amount
  // that actually reached `spender` -- the single primitive the deficit
  // cascade draws from.
  const drawFromSource = (
    source: EngineAccount,
    spender: EngineAccount,
    requested: number,
    month: ISODate,
    floor: number = 0
  ): number => {
    if (requested <= 0 || source.id === spender.id) return 0;
    const available = Math.max(0, (balances.get(source.id) ?? 0) - floor);
    if (available <= 0) return 0;
    const rate = estimatedWithdrawalRate(source);
    const provide = Math.min(requested, available / (1 + rate));
    if (provide <= 0) return 0;
    balances.set(source.id, (balances.get(source.id) ?? 0) - provide);
    balances.set(spender.id, (balances.get(spender.id) ?? 0) + provide);
    acc.rollforward.get(source.id)!.withdrawals += provide;
    acc.rollforward.get(spender.id)!.deposits += provide;
    acc.deficitCovered += provide;
    const tax = realizeWithdrawalTax(source.id, provide);
    addTo(acc.withdrawalNetByAccount, source.id, provide);
    addTo(acc.withdrawalTaxByAccount, source.id, tax);
    ledger.push({
      date: month,
      kind: "deficit_withdrawal",
      accountId: source.id,
      toAccountId: spender.id,
      amount: provide,
      note: tax > 0.005 ? `Covering shortfall in ${spender.name} (+ ${Math.round(tax)} tax)` : `Covering shortfall in ${spender.name}`,
    });
    return provide;
  };

  // ---------------------------------------------------------------------
  // The no-overdraft rule. An asset account can only ever hand over money it
  // actually holds: every outflow aimed at a SPECIFIC account (a tuition bill
  // paid straight from a 529, a transfer out of a brokerage, an RMD, a
  // cap-overflow rebalance) is sized by these two helpers, so the account
  // lands at exactly $0 rather than going negative -- which, left unchecked,
  // then compounds under the growth step into a runaway fictional debt.
  //
  // The one deliberate exception is the spending hub itself: it's allowed to
  // dip below $0 mid-month precisely so the deficit cascade (step 6) can see
  // the shortfall and pull from the drain order. If the cascade can't cover
  // it either, the hub STAYS negative -- that's the household genuinely
  // running out of money, and it must stay visible in net worth and in the
  // "insufficient funds" warning rather than being quietly clamped away.
  // ---------------------------------------------------------------------

  /**
   * The largest NET amount that can leave `account` without overdrawing it
   * once the withdrawal's own tax is realized at the source -- the same
   * `available / (1 + rate)` gross-up the deficit cascade uses, since
   * estimatedWithdrawalRate reproduces exactly what realizeWithdrawalTax will
   * charge on this balance. Liabilities pass through untouched (their
   * balances are amounts owed, not funds to spend).
   */
  const affordableOutflow = (account: EngineAccount, requested: number): number => {
    if (requested <= 0) return 0;
    if (account.category !== "asset") return requested;
    const balance = balances.get(account.id) ?? 0;
    if (balance <= 0) return 0;
    return Math.min(requested, balance / (1 + estimatedWithdrawalRate(account)));
  };

  /**
   * Charges `unmet` -- the part of a directed outflow the account itself
   * couldn't cover -- to the spending hub, so the money still comes from
   * somewhere real. The hub's balance drops now and the deficit cascade
   * (step 6, later this same month) refills it from the drain order in list
   * order: exactly the "next account in the withdrawal routing" behavior,
   * reusing the one cascade rather than duplicating it here.
   *
   * Callers own their cash-flow bookkeeping for the spilled amount -- an
   * expense needs none (the full expense is already in totalExpenses, and
   * only the part the source DID fund is offset via directExpenseFromAccounts),
   * whereas a transfer leg has to record the hub leg itself.
   */
  const chargeShortfallToHub = (source: EngineAccount, unmet: number, label: string, month: ISODate): void => {
    if (!primarySpendingAccountId || primarySpendingAccountId === source.id || unmet <= 0.005) return;
    balances.set(primarySpendingAccountId, (balances.get(primarySpendingAccountId) ?? 0) - unmet);
    acc.rollforward.get(primarySpendingAccountId)!.withdrawals += unmet;
    ledger.push({
      date: month,
      kind: "shortfall_spill",
      accountId: primarySpendingAccountId,
      toAccountId: source.id,
      amount: unmet,
      note: `${source.name} is out of money -- ${label} covered by the withdrawal routing instead`,
    });
    const warnKey = `${currentYear}:depleted:${source.id}`;
    if (!warnedThisYear.has(warnKey)) {
      warnedThisYear.add(warnKey);
      warnings.push({
        year: currentYear,
        kind: "account_depleted",
        accountId: source.id,
        message: `${source.name} is fully drawn down as of ${month} -- what it can't cover is taken from the next account in your withdrawal routing.`,
      });
    }
  };

  /** Every account outflow for a period, as one gross/net/tax line per source account. */
  const withdrawalItems = (periodAcc: YearAccumulator) => {
    const ids = new Set<Id>([...periodAcc.withdrawalNetByAccount.keys(), ...periodAcc.withdrawalTaxByAccount.keys()]);
    return [...ids]
      .map((id) => {
        const net = periodAcc.withdrawalNetByAccount.get(id) ?? 0;
        const tax = periodAcc.withdrawalTaxByAccount.get(id) ?? 0;
        const account = accountById.get(id);
        return {
          id,
          label: account?.name ?? id,
          taxTreatment: account ? effectiveTaxTreatment(account) : ("n/a" as const),
          gross: net + tax,
          net,
          tax,
        };
      })
      .filter((w) => w.gross > 0.005)
      .sort((a, b) => b.gross - a.gross);
  };

  /**
   * The exact, bracket-computed part of a period's tax picture. Only knowable
   * once a whole year's income is realized, so it's computed in December and
   * attached to that year's annual row AND to December's monthly row --
   * every other month gets NO_EXACT_TAX. See CashFlowPeriodRow's doc comment.
   */
  interface ExactTaxFigures {
    federalTaxTotal: number;
    federalTaxByComponent: FederalTaxComponent[];
    ordinaryTaxableIncome: number;
    taxableSocialSecurityAmount: number;
  }
  const NO_EXACT_TAX: ExactTaxFigures = {
    federalTaxTotal: 0,
    federalTaxByComponent: [],
    ordinaryTaxableIncome: 0,
    taxableSocialSecurityAmount: 0,
  };

  /**
   * Builds one PeriodSnapshot from a period's accumulated activity and its
   * opening balances. THE single place a snapshot is constructed -- the
   * annual path passes the whole year's accumulator, the monthly path passes
   * a one-month diff of that same accumulator (see diffAccumulator). Because
   * both go through here, a year's twelve monthly rows sum to its annual row
   * by construction rather than by two implementations agreeing.
   *
   * Reads `balances` live, so callers must invoke it only when balances are
   * final for the period (in particular, AFTER December's tax settlement).
   */
  const buildPeriodSnapshot = (
    granularity: Granularity,
    periodKey: string,
    periodLabel: string,
    periodEndDate: ISODate,
    periodMidDate: ISODate,
    year: number,
    periodAcc: YearAccumulator,
    openingBalances: Map<Id, number>,
    exactTax: ExactTaxFigures
  ): PeriodSnapshot => {
    const toLineItems = (map: Map<Id, number>) =>
      [...map.entries()]
        .map(([id, amount]) => ({ id, label: itemLabels.get(id) ?? id, amount, startDate: itemFirstDate.get(id) ?? null }))
        .sort((a, b) => b.amount - a.amount);
    const toAccountItems = (map: Map<Id, number>) =>
      [...map.entries()]
        .filter(([, amount]) => amount > 0.005)
        .map(([id, amount]) => ({ id, label: accountById.get(id)?.name ?? id, amount, startDate: null }))
        .sort((a, b) => b.amount - a.amount);

    const rollforwards: AccountPeriodRollforward[] = accounts.map((account) => {
      const bucket = periodAcc.rollforward.get(account.id) ?? { growth: 0, deposits: 0, withdrawals: 0 };
      return {
        accountId: account.id,
        year,
        startingBalance: openingBalances.get(account.id) ?? 0,
        inflationAdjustment: 0, // folded into growth/deposits per-posting; see forecast engine spec
        growth: bucket.growth,
        deposits: bucket.deposits,
        withdrawals: bucket.withdrawals,
        endingBalance: balances.get(account.id) ?? 0,
      };
    });

    // Excluded accounts don't count toward net worth, KPIs, or subtotals.
    const totalAssetsNominal = activeAccounts
      .filter((a) => a.category === "asset")
      .reduce((s, a) => s + (balances.get(a.id) ?? 0), 0);
    const totalLiabilitiesNominal = activeAccounts
      .filter((a) => a.category === "liability")
      .reduce((s, a) => s + (balances.get(a.id) ?? 0), 0);
    const netWorthNominal = totalAssetsNominal - totalLiabilitiesNominal;
    // Balances deflate by the inflation elapsed through the period's LAST DAY;
    // flows, which land throughout the period, deflate to its midpoint.
    const cumulativeInflation = Math.pow(
      1 + settings.inflationRatePct,
      Math.max(0, elapsedYears(settings.startDate, periodEndDate))
    );
    const flowInflationDeflator = Math.pow(
      1 + settings.inflationRatePct,
      Math.max(0, elapsedYears(settings.startDate, periodMidDate))
    );

    // "Ending cash on hand" (display only) is the total across every
    // class="cash" account -- a surplus swept from the hub into checking or an
    // emergency fund is still cash, not withdrawn or invested.
    const endingCashBalance = [...cashAccountIds].reduce((s, id) => s + (balances.get(id) ?? 0), 0);
    // "Net change in cash" and "Interest earned on cash" -- the reconciling
    // figures the itemized rows above them must sum to -- stay scoped to the
    // hub, not every cash account (see CashFlowPeriodRow.netCashFlow).
    const hubCashStart = [...hubIds].reduce((s, id) => s + (openingBalances.get(id) ?? 0), 0);
    const hubEndingBalance = [...hubIds].reduce((s, id) => s + (balances.get(id) ?? 0), 0);
    const hubCashInterest = [...hubIds].reduce((s, id) => s + (periodAcc.rollforward.get(id)?.growth ?? 0), 0);

    const cashFlow: CashFlowPeriodRow = {
      year,
      totalIncome: periodAcc.totalIncome,
      totalExpenses: periodAcc.totalExpenses,
      operatingCashFlow: periodAcc.totalIncome - periodAcc.totalExpenses,
      // Ground truth: the hub's actual measured balance change this period.
      // Always exactly right, regardless of which mechanism moved the money.
      netCashFlow: hubEndingBalance - hubCashStart,
      surplusRouted: periodAcc.surplusRouted,
      // Cash that flowed in from accounts to cover the operating gap: deficit
      // draws + RMD proceeds, plus any expense paid directly from an investment
      // (which offsets that expense, since cash was never touched).
      withdrawalsToCashNet: periodAcc.deficitCovered + periodAcc.rmdTotal + periodAcc.directExpenseFromAccounts,
      rmdTotal: periodAcc.rmdTotal,
      withdrawalTaxes: periodAcc.taxesPaid,
      taxSettlement: periodAcc.taxSettlement,
      incomeTaxWithheldFromCash: periodAcc.incomeWithheldFromHub,
      cashInterest: hubCashInterest,
      // Edge-case bucket: transfers touching the hub directly, net of income
      // that bypassed the hub entirely. Zero in the common case.
      otherAccountActivity: periodAcc.hubTransferNet - periodAcc.directIncomeToOtherAccounts,
      otherActivityByItem: [...periodAcc.otherActivityByItem.entries()]
        .filter(([, amount]) => Math.abs(amount) > 0.005)
        .map(([id, amount]) => ({
          id,
          label: itemLabels.get(id) ?? id,
          amount,
          startDate: itemFirstDate.get(id) ?? null,
          accountId: otherActivityAccountId.get(id) ?? null,
        }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
      endingCashBalance,
      afterTaxContributionTotal: periodAcc.afterTaxContributions,
      incomeByItem: toLineItems(periodAcc.incomeByItem),
      expenseByItem: toLineItems(periodAcc.expenseByItem),
      contributionsByItem: [...periodAcc.contributionsByItem.entries()]
        .map(([id, amount]) => ({
          id,
          label: itemLabels.get(id) ?? id,
          amount,
          startDate: itemFirstDate.get(id) ?? null,
          fromPaycheck: contributionFromPaycheck.get(id) ?? false,
        }))
        .sort((a, b) => b.amount - a.amount),
      surplusByAccount: toAccountItems(periodAcc.surplusByAccount),
      withdrawalsByAccount: withdrawalItems(periodAcc),
      capitalGainsRealized: periodAcc.capitalGainsRealized,
      grossSocialSecurity: periodAcc.grossSocialSecurity,
      ...exactTax,
    };

    return {
      granularity,
      periodKey,
      periodLabel,
      year,
      date: periodEndDate,
      totalAssetsNominal,
      totalLiabilitiesNominal,
      netWorthNominal,
      netWorthReal: netWorthNominal / cumulativeInflation,
      inflationDeflator: cumulativeInflation,
      flowInflationDeflator,
      accountBalances: Object.fromEntries(balances),
      rollforwards,
      cashFlow,
    };
  };

  const simulationMonths = [...eachMonthStart(settings.startDate, settings.horizonEndDate)];
  // Opening balances / accumulator state for the month currently being
  // simulated -- the baselines the monthly snapshot differences against.
  let monthStartBalances = new Map<Id, number>(balances);
  let accAtMonthStart = cloneAccumulator(acc);

  for (let i = 0; i < simulationMonths.length; i++) {
    const month = simulationMonths[i];
    currentMonth = month;
    const yearMonth = month.slice(0, 7);
    const isJanuary = month.endsWith("-01-01");
    // Inside the monthly drill-down window, record this month's opening state
    // so its own activity can be recovered by differencing at month end.
    const inMonthlyWindow = compareDates(month, monthlyDetailThrough) <= 0;
    if (inMonthlyWindow) {
      monthStartBalances = new Map(balances);
      accAtMonthStart = cloneAccumulator(acc);
    }

    // Captured BEFORE this month's growth/postings/mortgages/RMDs run, so the
    // surplus split (step 5) can size itself off exactly this month's FRESH
    // inflow to Extra Savings -- see step 5 for why that distinction matters.
    const extraSavingsMonthStart = extraSavingsAccount ? balances.get(extraSavingsAccount.id) ?? 0 : 0;

    // 0. Home sales: a sell_home event tags the real_estate account being
    //    sold (and its linked mortgage, if any) with soldDate -- the balance
    //    is forced to exactly $0 starting that month and every month after,
    //    an actual retirement rather than the frozen-balance simplification
    //    replaceHousingExpenses uses. Recorded as a withdrawal of whatever
    //    was left so the rollforward still balances (start + growth +
    //    deposits - withdrawals = end). Runs before growth (step 1) so
    //    nothing accrues on a sold home's final month, and before
    //    amortization (step 3) so a sold mortgage's currentBalance<=0 guard
    //    already sees it as paid off -- no separate payment-skipping needed.
    //
    //    Computed-proceeds sales (saleInfo set) credit the proceeds here,
    //    BEFORE any balance is zeroed, from the actual simulated equity:
    //    home value × (1 − selling costs) − remaining linked mortgage.
    for (const account of accounts) {
      if (!account.saleInfo || !account.soldDate || compareDates(month, account.soldDate) < 0) continue;
      const homeValue = balances.get(account.id) ?? 0;
      if (homeValue === 0) continue; // already sold in an earlier month
      const mortgageBalance = account.linkedLiabilityId ? balances.get(account.linkedLiabilityId) ?? 0 : 0;
      const proceeds = homeValue * (1 - account.saleInfo.sellingCostsPct) - mortgageBalance;
      const targetId = account.saleInfo.proceedsAccountId ?? primarySpendingAccountId;
      if (targetId && Math.abs(proceeds) > 0.005) {
        // An underwater sale (mortgage payoff exceeding the home's equity)
        // makes "proceeds" a DEBIT on the target account -- clamp it like any
        // other outflow so a small proceeds account can't be driven negative.
        const targetAccount = accountById.get(targetId);
        let applied = proceeds;
        if (proceeds < 0 && targetAccount && primarySpendingAccountId && !hubIds.has(targetId)) {
          applied = -affordableOutflow(targetAccount, -proceeds);
          const unmet = -proceeds - -applied;
          if (unmet > 0.005) {
            chargeShortfallToHub(targetAccount, unmet, `Home sale shortfall: ${account.name}`, month);
            acc.hubTransferNet -= unmet;
            recordOtherActivity(
              `${account.id}:sale:unfunded`,
              `Home sale: ${account.name} (${targetAccount.name} empty -- covered from cash)`,
              account.id,
              -unmet,
              month
            );
          }
        }
        balances.set(targetId, (balances.get(targetId) ?? 0) + applied);
        const targetBucket = acc.rollforward.get(targetId);
        if (targetBucket) {
          if (applied >= 0) targetBucket.deposits += applied;
          else targetBucket.withdrawals += -applied;
        }
        // Asset-for-asset swap (home equity -> cash): reconcile like any
        // other transfer leg landing on the hub directly.
        if (hubIds.has(targetId)) {
          acc.hubTransferNet += applied;
          recordOtherActivity(`${account.id}:sale`, `Home sale: ${account.name}`, account.id, applied, month);
        }
        ledger.push({
          date: month,
          kind: "home_sale",
          accountId: account.id,
          toAccountId: targetId,
          amount: applied,
          note: `Sold ${account.name}: value ${Math.round(homeValue).toLocaleString()} − selling costs − mortgage payoff ${Math.round(mortgageBalance).toLocaleString()}`,
        });
      }
    }
    for (const account of accounts) {
      if (!account.soldDate || compareDates(month, account.soldDate) < 0) continue;
      const remaining = balances.get(account.id) ?? 0;
      if (remaining === 0) continue;
      balances.set(account.id, 0);
      const bucket = acc.rollforward.get(account.id);
      if (bucket) bucket.withdrawals += remaining;
    }

    // 1. Growth (skipped in an account's creation month -- mirrors the
    //    proven prior engine's "no interest on day one" rule -- and skipped
    //    entirely for excluded accounts, which stay frozen at their starting
    //    balance once set).
    for (const account of accounts) {
      if (!hasReachedStartMonth(month, account.effectiveStartDate)) continue;
      // An account's own creation month normally seeds it -- but that month
      // never gets simulated when effectiveStartDate already precedes the
      // plan's own start (e.g. a buy_home event whose closing date is now in
      // the past because plan start auto-tracks "today"). Without this, such
      // an account would sit frozen at the balances map's $0 default forever
      // -- seed it on month one instead, the earliest this plan ever sees it.
      const isCreationMonth =
        month.slice(0, 7) === account.effectiveStartDate.slice(0, 7) ||
        (i === 0 && compareDates(account.effectiveStartDate, month) < 0);
      if (isCreationMonth) {
        // The opening balance is the account's starting balance for its first
        // year -- surface it in the "Starting balance" rollforward row rather
        // than counting it as a deposit. Cost basis starts at the entered
        // startingCostBasis (embedded unrealized gains), else the whole
        // balance (no embedded gains -- the historical assumption).
        balances.set(account.id, account.startingBalance);
        yearStartBalances.set(account.id, account.startingBalance);
        // Same for the month baseline, or the account's first monthly
        // rollforward would open at $0 and report its whole opening balance
        // as a deposit.
        monthStartBalances.set(account.id, account.startingBalance);
        basis.set(account.id, Math.min(account.startingCostBasis ?? account.startingBalance, account.startingBalance));
        continue;
      }
      if (account.isExcluded) continue;
      if (account.class === "credit_card" || account.class === "loan" || account.class === "mortgage") continue;
      // Never compound a balance that isn't there. Only the spending hub can
      // legitimately sit below $0 (see the no-overdraft rule above), and
      // applying a growth rate to an overdrawn balance would manufacture a
      // snowballing loss no real account charges -- it would also grow the
      // hole faster than the deficit cascade could ever close it.
      const balance = balances.get(account.id) ?? 0;
      if (balance <= 0) continue;
      const rate = monthlyRateFromAnnual(effectiveAnnualRate(account, month, settings.inflationRatePct));
      if (!rate) continue;
      const growthAmount = balance * rate;
      balances.set(account.id, (balances.get(account.id) ?? 0) + growthAmount);
      acc.rollforward.get(account.id)!.growth += growthAmount;
    }

    // 2. Scheduled cashflows for this month. (resolveEvents already omits
    //    postings targeting an excluded account; this check is a cheap backstop.)
    for (const posting of postingsByMonth.get(yearMonth) ?? []) {
      const targetAccount = accountById.get(posting.accountId);
      if (targetAccount?.isExcluded) continue;
      if (!hasReachedStartMonth(month, targetAccount?.effectiveStartDate ?? month)) continue;
      const bucket = acc.rollforward.get(posting.accountId);
      // Money sent TO a liability (a transfer aimed at a mortgage/loan, or
      // income directed at one) PAYS IT DOWN -- liability balances are
      // stored as positive amounts owed, so a naive `+= amount` would GROW
      // the debt. Paydown is capped at the remaining balance; any excess is
      // returned to the spending hub rather than vanishing.
      let liabilityExcessToHub = 0;
      // The net amount that actually left the target account for this posting
      // (0 for an inflow). Usually the full request; less when the account
      // ran dry and the no-overdraft rule capped it.
      let outflowApplied = posting.amount < 0 ? -posting.amount : 0;
      if (posting.amount > 0 && targetAccount && targetAccount.category === "liability") {
        const owed = balances.get(posting.accountId) ?? 0;
        const applied = Math.min(posting.amount, owed);
        balances.set(posting.accountId, owed - applied);
        if (bucket) bucket.withdrawals += applied; // reducing a liability is a "withdrawal" from its balance
        liabilityExcessToHub = posting.amount - applied;
        if (liabilityExcessToHub > 0 && primarySpendingAccountId && primarySpendingAccountId !== posting.accountId) {
          balances.set(primarySpendingAccountId, (balances.get(primarySpendingAccountId) ?? 0) + liabilityExcessToHub);
          acc.rollforward.get(primarySpendingAccountId)!.deposits += liabilityExcessToHub;
          if (hubIds.has(primarySpendingAccountId)) {
            acc.hubTransferNet += liabilityExcessToHub;
            recordOtherActivity(
              `${posting.sourceId}:excess`,
              `${posting.label} (excess over payoff, returned to cash)`,
              posting.accountId,
              liabilityExcessToHub,
              posting.date
            );
          }
        }
      } else if (
        posting.amount < 0 &&
        targetAccount &&
        targetAccount.category === "asset" &&
        primarySpendingAccountId &&
        !hubIds.has(posting.accountId)
      ) {
        // An outflow aimed at a SPECIFIC asset account -- a tuition bill paid
        // straight from a 529, a transfer out of a brokerage. It can only
        // take what the account holds (net of the tax that draw realizes), so
        // an over-sized withdrawal rate empties the account to exactly $0
        // instead of driving it negative; the rest is charged to the hub and
        // picked up by the drain order below.
        outflowApplied = affordableOutflow(targetAccount, -posting.amount);
        balances.set(posting.accountId, (balances.get(posting.accountId) ?? 0) - outflowApplied);
        if (bucket) bucket.withdrawals += outflowApplied;
        const unmet = -posting.amount - outflowApplied;
        if (unmet > 0.005) {
          chargeShortfallToHub(targetAccount, unmet, posting.label, month);
          // An EXPENSE needs no further bookkeeping: its full amount is
          // already in totalExpenses, and only the part this account actually
          // funded is offset via directExpenseFromAccounts below -- so the
          // hub's drop reconciles on its own. A transfer leg has no such
          // line, so the hub's share of it has to be recorded here.
          if (posting.category !== "expense") {
            acc.hubTransferNet -= unmet;
            recordOtherActivity(
              `${posting.sourceId}:unfunded`,
              `${posting.label} (${targetAccount.name} empty -- covered from cash)`,
              posting.accountId,
              -unmet,
              posting.date
            );
          }
        }
      } else {
        balances.set(posting.accountId, (balances.get(posting.accountId) ?? 0) + posting.amount);
        if (bucket) {
          if (posting.amount >= 0) bucket.deposits += posting.amount;
          else bucket.withdrawals += -posting.amount;
        }
      }
      if (posting.category === "income") {
        acc.totalIncome += posting.amount;
        addTo(acc.incomeByItem, posting.sourceId, posting.amount);
        itemLabels.set(posting.sourceId, posting.label);
        markFirstDate(posting.sourceId, posting.date);
        // Income landing straight in a non-hub account (e.g. a windfall
        // deposited to a brokerage) still counts in totalIncome for the
        // itemized list, but never reached cash on hand -- track separately
        // so it doesn't inflate the reconciled Net. (Any liability-paydown
        // excess bounced back to the hub DID reach cash, so it's not direct.)
        if (!hubIds.has(posting.accountId)) {
          const direct = posting.amount - liabilityExcessToHub;
          acc.directIncomeToOtherAccounts += direct;
          // Negative: this income counted in totalIncome above but never
          // reached cash, so it subtracts back out of the reconciliation.
          recordOtherActivity(
            `${posting.sourceId}:direct`,
            `${posting.label} (deposited to ${targetAccount?.name ?? "another account"})`,
            posting.accountId,
            -direct,
            posting.date
          );
        }

        // Social Security and pension income are entered GROSS (unlike every
        // other income category, which is take-home) so their real
        // taxability can be computed -- withhold an estimate now at this
        // year's converged rate; the exact bracket-computed bill overrides
        // this at year-end regardless (see federalTaxTotal below).
        const incomeSrc = incomeSourceById.get(posting.sourceId);
        // Salary is entered take-home, but a source can optionally also
        // carry a gross figure (see IncomeSource.grossAmount) so it can be
        // stacked under withdrawals/capital-gains for bracket placement --
        // no withholding is simulated against it (unlike SS/pension below),
        // since its own tax is assumed already reflected in the take-home
        // amount actually deposited.
        if (posting.amount > 0 && incomeSrc?.category === "salary" && posting.grossAmount != null) {
          acc.grossSalary += posting.grossAmount;
        }
        if (posting.amount > 0 && (incomeSrc?.category === "social_security" || incomeSrc?.category === "pension")) {
          const rates = ratesForYear(currentYear);
          const taxableFraction = incomeSrc.category === "social_security" ? rates.ssTaxableFraction : 1;
          if (incomeSrc.category === "social_security") acc.grossSocialSecurity += posting.amount;
          else acc.grossPension += posting.amount;
          const withheld = posting.amount * taxableFraction * rates.ordinaryMarginalRate;
          if (withheld > 0.005) {
            balances.set(posting.accountId, (balances.get(posting.accountId) ?? 0) - withheld);
            const withheldBucket = acc.rollforward.get(posting.accountId);
            if (withheldBucket) withheldBucket.withdrawals += withheld;
            acc.taxesPaid += withheld;
            // Withholding taken from a deposit that landed ON the hub reduces
            // cash directly -- tracked separately for the hub-scoped reconcile.
            if (hubIds.has(posting.accountId)) acc.incomeWithheldFromHub += withheld;
          }
        }
      } else if (posting.category === "expense") {
        acc.totalExpenses += -posting.amount;
        addTo(acc.expenseByItem, posting.sourceId, -posting.amount);
        itemLabels.set(posting.sourceId, posting.label);
        markFirstDate(posting.sourceId, posting.date);
      } else if (posting.category === "contribution_in") {
        addTo(acc.contributionsByItem, posting.sourceId, posting.amount);
        itemLabels.set(posting.sourceId, posting.label);
        markFirstDate(posting.sourceId, posting.date);
        const fromPaycheck = accountById.get(posting.accountId)?.contribution?.payrollDeducted ?? false;
        contributionFromPaycheck.set(posting.sourceId, fromPaycheck);
        // Take-home-funded contributions cost cash; the matching contribution_out
        // posting handles the spending-account balance, so we only tally the
        // total here (avoids double counting). Payroll-deducted ones cost nothing.
        if (!fromPaycheck) acc.afterTaxContributions += posting.amount;
        creditBasisIfTaxable(posting.accountId, posting.amount);
      } else if (posting.category === "transfer" && hubIds.has(posting.accountId)) {
        // A transfer leg landing on or leaving a hub directly (a custom
        // transfer to/from checking, or a buy_home down payment sourced from
        // checking) -- the only posting kind not otherwise captured by
        // income/expense/contribution tracking, so it needs its own bucket to
        // reconcile Net exactly.
        acc.hubTransferNet += posting.amount;
        // Label already carries the flow's identity ("Down payment: Buy a
        // home", "Home sale: ...", a custom transfer's name); the other leg
        // of a custom transfer isn't on this posting, so no counterparty.
        recordOtherActivity(posting.sourceId, posting.label, null, posting.amount, posting.date);
      }
      // contribution_out: balance + rollforward already handled above.
      // A non-hub-touching transfer leg needs no extra bookkeeping here --
      // outflows from a non-hub asset account are captured as withdrawals below.

      // Any outflow from a taxable / tax-deferred account (a transfer out, or an
      // expense paid straight from it) is a sale that realizes tax.
      if (outflowApplied > 0) {
        const outAmount = outflowApplied;
        const tax = realizeWithdrawalTax(posting.accountId, outAmount);
        // Money leaving a NON-hub asset account (a savings/investment) counts
        // as a withdrawal in the Cash Flow tab -- a direct expense paid from it,
        // or a transfer out of it. (Outflows from a hub are ordinary expenses.)
        if (targetAccount && targetAccount.category === "asset" && !hubIds.has(posting.accountId)) {
          addTo(acc.withdrawalNetByAccount, posting.accountId, outAmount);
          addTo(acc.withdrawalTaxByAccount, posting.accountId, tax);
          // A direct EXPENSE from an investment bypasses cash: it offsets the
          // same expense already counted above, so the net cash effect is zero.
          if (posting.category === "expense") acc.directExpenseFromAccounts += outAmount;
        }
      }
    }

    // 3. Amortize mortgages/loans (and credit cards that have loanTerms --
    //    a payoff plan -- so carried card debt doesn't sit frozen forever).
    for (const account of accounts) {
      if (account.isExcluded) continue;
      if (account.class !== "mortgage" && account.class !== "loan" && account.class !== "credit_card") continue;
      if (!hasReachedStartMonth(month, account.effectiveStartDate)) continue;
      if (month.slice(0, 7) === account.effectiveStartDate.slice(0, 7)) continue; // originates this month, first payment next month
      const currentBalance = balances.get(account.id) ?? 0;
      if (currentBalance <= 0) continue; // already paid off -- no more payments due
      const mortgage = mortgageByAccountId.get(account.id);
      const payment = mortgagePayments.get(account.id);
      if (!mortgage || !payment) continue;
      // A buy_home event's "replace existing housing expenses" retires an
      // already-owned home's mortgage -- no further payments after that date.
      // The remaining balance simply stops amortizing (no sale/payoff is
      // modeled), same simplification as a housing Expense that just stops.
      if (mortgage.paymentEndDate && compareDates(month, mortgage.paymentEndDate) > 0) continue;
      const step = amortizeMonth(currentBalance, mortgage.loanTerms.annualInterestRatePct, payment);

      // Extra principal on top of the scheduled payment -- capped at whatever
      // balance is left after the normal step, so the final payment never
      // overshoots. Reducing the balance faster while the payment stays fixed
      // is exactly what pays the loan off early (the currentBalance<=0 guard
      // above simply stops charging once it's gone).
      let principalPortion = step.principalPortion;
      let newBalance = step.newBalance;
      const extraWanted = mortgage.loanTerms.extraPrincipalMonthly ?? 0;
      if (extraWanted > 0 && newBalance > 0) {
        const extra = Math.min(extraWanted, newBalance);
        principalPortion += extra;
        newBalance -= extra;
      }
      balances.set(account.id, newBalance);
      acc.rollforward.get(account.id)!.withdrawals += principalPortion;

      const payerId = mortgage.payingAccountId;
      if (payerId) {
        // Interest + principal actually owed this month (incl. any extra
        // principal), not the flat scheduled payment -- these match every month
        // except possibly the final one, where the scheduled payment would
        // otherwise overpay/overcharge a loan that's paying off with less than
        // a full payment remaining.
        const actualPayment = step.interestPortion + principalPortion;
        // Paying from a non-hub account (a mortgage set to draw on a savings
        // account) can't overdraw it -- whatever that account is short is
        // charged to the hub for the drain order to cover, same as any other
        // directed outflow. The hub itself is exempt, by design.
        const payer = accountById.get(payerId);
        const paidFromPayer =
          payer && payer.category === "asset" && primarySpendingAccountId && !hubIds.has(payerId)
            ? affordableOutflow(payer, actualPayment)
            : actualPayment;
        balances.set(payerId, (balances.get(payerId) ?? 0) - paidFromPayer);
        const payerBucket = acc.rollforward.get(payerId);
        if (payerBucket) payerBucket.withdrawals += paidFromPayer;
        if (payer && actualPayment - paidFromPayer > 0.005) {
          chargeShortfallToHub(payer, actualPayment - paidFromPayer, `Mortgage payment (${account.name})`, month);
        }
        acc.totalExpenses += actualPayment;
        addTo(acc.expenseByItem, account.id, actualPayment);
        itemLabels.set(account.id, `Mortgage payment (${account.name})`);
        markFirstDate(account.id, month);
        ledger.push({
          date: month,
          kind: "mortgage_payment",
          accountId: payerId,
          toAccountId: account.id,
          amount: actualPayment,
          note: `Mortgage payment (${account.name})`,
        });
      }
    }

    // 4. RMDs -- once per year, in January, using the prior Dec-31 balance.
    //    Honors the global settings.rmdEnabled toggle, and SECURE 2.0's
    //    birth-year-dependent start age (73 for born 1951-1959, 75 for 1960+).
    if (isJanuary && settings.rmdEnabled) {
      const year = yearOf(month);
      for (const account of accounts) {
        if (account.isExcluded || !account.subjectToRMD || !account.ownerId) continue;
        // Roth accounts (401k or IRA) are never subject to RMDs during the
        // owner's life -- SECURE 2.0 eliminated the old Roth 401(k) RMD rule
        // starting in 2024. Guard here regardless of the checkbox above, since
        // a Roth 401(k) is easy to mis-set as class="tax_deferred" (it's still
        // a "401k") while carrying taxTreatment="tax_free".
        if (effectiveTaxTreatment(account) === "tax_free") continue;
        if (!hasReachedStartMonth(month, account.effectiveStartDate)) continue;
        const owner = scenario.household.people.find((p) => p.id === account.ownerId);
        if (!owner) continue;
        const age = ageOn(owner.birthDate, endOfYear(year));
        if (age < rmdStartAgeForBirthYear(yearOf(owner.birthDate))) continue;
        const divisor = rmdDivisor(age);
        const priorBalance = priorYearEndBalances.get(account.id) ?? 0;
        if (!divisor || priorBalance <= 0) continue;
        // Sized off the PRIOR Dec-31 balance, as the IRS requires -- but the
        // account may hold less than that by now (a big withdrawal, a down
        // market), so distribute at most what's actually left after its own
        // tax rather than overdrawing it.
        const rmdAmount = affordableOutflow(account, priorBalance / divisor);
        if (rmdAmount <= 0.005) continue;
        balances.set(account.id, (balances.get(account.id) ?? 0) - rmdAmount);
        acc.rollforward.get(account.id)!.withdrawals += rmdAmount;
        acc.rmdTotal += rmdAmount;
        if (primarySpendingAccountId && primarySpendingAccountId !== account.id) {
          balances.set(primarySpendingAccountId, (balances.get(primarySpendingAccountId) ?? 0) + rmdAmount);
          acc.rollforward.get(primarySpendingAccountId)!.deposits += rmdAmount;
        }
        // Tax on the forced distribution, realized at the source like any other
        // withdrawal from the account.
        const rmdTax = realizeWithdrawalTax(account.id, rmdAmount);
        addTo(acc.withdrawalNetByAccount, account.id, rmdAmount);
        addTo(acc.withdrawalTaxByAccount, account.id, rmdTax);
        ledger.push({
          date: month,
          kind: "rmd",
          accountId: account.id,
          toAccountId: primarySpendingAccountId ?? undefined,
          amount: rmdAmount,
          note: `RMD at age ${age} (divisor ${divisor})`,
        });
      }
    }

    // 5. Extra Savings surplus split. Extra Savings has no user-configurable
    //    floor/ceiling of its own -- freshSurplus is exactly what THIS MONTH
    //    added to its balance (captured before growth/postings/mortgages/RMDs
    //    ran, at the top of this iteration), not its running total. This is
    //    deliberate: splitting against the whole balance would re-offer money
    //    that already accumulated in a prior month -- left unclaimed on
    //    purpose, as a reserve -- to the split again, slowly draining it
    //    instead of letting it grow. Each stop is either a flat $ amount or a
    //    percentage of what's left after the stops above it (cascading, not a
    //    share of the original total); a stop's own maxBalance ceiling still
    //    applies on top of that, and anything a capped stop can't absorb
    //    spills to the next stop, same as the old fill order. Whatever the
    //    whole list doesn't claim simply stays in Extra Savings. Only stops
    //    whose optional date window covers this month participate -- lets a
    //    target sit out of the split entirely until, say, a few years before
    //    retirement.
    const yearsSinceStart = currentYear - yearOf(settings.startDate);
    const inflationFactor = Math.pow(1 + settings.inflationRatePct, Math.max(0, yearsSinceStart));
    const activeSplitStops = splitStops.filter(({ stop }) => isSplitStopActive(stop, month));
    // Offers `amount` (cash sitting in Extra Savings right now) to the split
    // order and returns what was actually claimed. Shared by the monthly
    // fresh-surplus split below and December's tax true-up refund (step 8):
    // the refund is ordinary surplus cash, but it posts after this step has
    // already run for December, and the fresh-surplus rule means no later
    // month ever re-offers it -- so it needs to be routed explicitly at the
    // point it lands rather than left to strand in the hub as cash.
    const routeThroughSplitOrder = (amount: number): number => {
      if (!extraSavingsAccount || amount <= 0.005) return 0;
      let remaining = amount;
      for (const { account: target, stop } of activeSplitStops) {
        if (remaining <= 0.005) break;
        if (target.id === extraSavingsAccount.id) continue;
        const cap = effectiveBalanceCeiling(target, yearsSinceStart, settings.inflationRatePct);
        const room = cap - (balances.get(target.id) ?? 0);
        if (room <= 0) continue; // target already at/over its ceiling -- spill onward
        // The stop's own allowance for this period. Exhausted (e.g. the year's
        // contribution room is used up) it spills onward exactly like a full
        // target does, rather than stalling the rest of the split.
        const allowance = remainingFlowLimit(stop, month, yearsSinceStart);
        if (allowance <= 0) continue;
        const offered = stop.kind === "flat" ? (stop.amount ?? 0) * inflationFactor : remaining * (stop.pct ?? 0);
        const take = Math.min(offered, room, remaining, allowance);
        if (take <= 0) continue;
        recordFlowUse(stop, month, take);
        balances.set(extraSavingsAccount.id, (balances.get(extraSavingsAccount.id) ?? 0) - take);
        balances.set(target.id, (balances.get(target.id) ?? 0) + take);
        acc.rollforward.get(extraSavingsAccount.id)!.withdrawals += take;
        acc.rollforward.get(target.id)!.deposits += take;
        acc.surplusRouted += take;
        addTo(acc.surplusByAccount, target.id, take);
        creditBasisIfTaxable(target.id, take);
        remaining -= take;
        ledger.push({
          date: month,
          kind: "surplus_route",
          accountId: extraSavingsAccount.id,
          toAccountId: target.id,
          amount: take,
          note: `Surplus split from ${extraSavingsAccount.name} to ${target.name}`,
        });
      }
      return amount - remaining;
    };
    if (extraSavingsAccount) {
      routeThroughSplitOrder((balances.get(extraSavingsAccount.id) ?? 0) - extraSavingsMonthStart);
    }

    // 5b. Cap overflow. The split above only catches money entering a target
    //     from Extra Savings. A target can also exceed its ceiling via a custom
    //     transfer landing on it directly, income deposited straight into it,
    //     or its own organic growth -- which is exactly why the ceiling lives
    //     on the account rather than on the routing stop. So: for every split
    //     stop currently above its ceiling, walk later stops in list order and
    //     push the excess down the chain, landing wherever there's room. This
    //     is a rebalance between the user's own accounts, so it's recorded in
    //     rollforwards (balances must still reconcile) but explicitly NOT
    //     counted in the surplusRouted headline, which tracks routed income
    //     only. Uses the same active (date-window) subset as the split above.
    //
    //     Overflow still consumes the DESTINATION stop's rate limit: money
    //     landing in, say, a Roth IRA is a contribution against that year's
    //     room no matter which account it came from, so exempting overflow
    //     would leave an obvious way around the limit. An excess that has
    //     nowhere left to go stays put, same as when every target is full.
    for (let ti = 0; ti < activeSplitStops.length; ti++) {
      const over = activeSplitStops[ti];
      const overCap = effectiveBalanceCeiling(over.account, yearsSinceStart, settings.inflationRatePct);
      let excess = (balances.get(over.account.id) ?? 0) - overCap;
      if (excess <= 0.005) continue;
      for (let tj = ti + 1; tj < activeSplitStops.length && excess > 0.005; tj++) {
        const dest = activeSplitStops[tj];
        const destCap = effectiveBalanceCeiling(dest.account, yearsSinceStart, settings.inflationRatePct);
        const room = destCap - (balances.get(dest.account.id) ?? 0);
        if (room <= 0) continue; // next target also full -- keep spilling onward
        const destAllowance = remainingFlowLimit(dest.stop, month, yearsSinceStart);
        if (destAllowance <= 0) continue; // period allowance used up -- keep spilling onward
        // Capped by what the over-cap account can actually part with once the
        // sale's tax is realized -- otherwise a cap of $0 would move the whole
        // balance out and the tax on top would leave it negative.
        const move = Math.min(room, destAllowance, affordableOutflow(over.account, excess));
        if (move <= 0.005) continue;
        recordFlowUse(dest.stop, month, move);
        balances.set(over.account.id, (balances.get(over.account.id) ?? 0) - move);
        balances.set(dest.account.id, (balances.get(dest.account.id) ?? 0) + move);
        acc.rollforward.get(over.account.id)!.withdrawals += move;
        acc.rollforward.get(dest.account.id)!.deposits += move;
        // Overflowing out of a taxable account is still a sale -- tax it.
        const overflowTax = realizeWithdrawalTax(over.account.id, move);
        creditBasisIfTaxable(dest.account.id, move);
        excess -= move;
        ledger.push({
          date: month,
          kind: "cap_overflow",
          accountId: over.account.id,
          toAccountId: dest.account.id,
          amount: move,
          note:
            overflowTax > 0.005
              ? `${over.account.name} over its cap -- moved to ${dest.account.name} (+ ${Math.round(overflowTax)} tax)`
              : `${over.account.name} over its cap -- moved to ${dest.account.name}`,
        });
      }
      // Any excess still left here had nowhere to go (every downstream target is
      // full and there is no uncapped catch-all); it stays put -- we can't force
      // money out with no destination.
    }

    // 6. Deficit cascade. Triggers once Extra Savings drops below $0 --
    //    hardcoded, not user-configurable (see splitStopSchema/moneyFlowSchema
    //    docs: Extra Savings has no floor/ceiling input of its own). Mirrors
    //    the surplus split above: each stop, in list order, is offered
    //    either a flat $ amount or a percentage of what's left after the
    //    stops above it (cascading, not a share of the original shortfall),
    //    capped by its own floor -- whatever a stop can't cover (floor hit,
    //    or its offered amount undershoots) spills to the next stop. Only
    //    drain stops whose optional date window covers this month
    //    participate -- lets e.g. a brokerage fund a shortfall for a few
    //    years until a later account becomes the active source.
    if (extraSavingsAccount) {
      const spender = extraSavingsAccount;
      let shortfall = 0 - (balances.get(spender.id) ?? 0);
      if (shortfall > 0) {
        const active = drainStops.filter(({ stop }) => isDrainStopActive(stop, month));
        for (const { account: source, stop } of active) {
          if (shortfall <= 0.005) break;
          const floor = effectiveBalanceFloor(source, yearsSinceStart, settings.inflationRatePct);
          // This stop's remaining allowance for the period -- e.g. "no more
          // than $40k a year out of the brokerage", to keep realized gains
          // inside a bracket. Exhausted, the stop simply contributes nothing
          // this month and the shortfall spills to the next source, exactly
          // as when the floor blocks it.
          const allowance = remainingFlowLimit(stop, month, yearsSinceStart);
          if (allowance <= 0) continue;
          const offered = stop.kind === "flat" ? (stop.amount ?? 0) * inflationFactor : shortfall * (stop.pct ?? 0);
          // drawFromSource returns the NET amount that reached the hub; the
          // allowance is measured on that same net figure, so a limit reads as
          // "how much this account may send", not "how much it may liquidate".
          const drawn = drawFromSource(source, spender, Math.min(offered, allowance), month, floor);
          recordFlowUse(stop, month, drawn);
          shortfall -= drawn;
        }
      }
    }

    // 6b. Floating-point tidy-up. A draw sized to empty an account exactly
    //     (available / (1 + tax rate), with the tax then charged back at the
    //     source) lands on zero in real arithmetic but can leave a residue of
    //     a billionth of a cent on either side of it in floating point -- which
    //     renders as "-$0" in the balances table. Snap those to a true zero, at
    //     a threshold far below a cent so no real money is ever moved.
    for (const account of activeAccounts) {
      if (account.category !== "asset") continue;
      const balance = balances.get(account.id) ?? 0;
      if (balance !== 0 && Math.abs(balance) < 1e-6) balances.set(account.id, 0);
    }

    // 7. Warnings -- any (non-excluded) asset account still negative after the above.
    const year = yearOf(month);
    for (const account of accounts) {
      if (account.isExcluded || account.category !== "asset") continue;
      const balance = balances.get(account.id) ?? 0;
      if (balance >= -0.005) continue;
      const key = `${year}:${account.id}`;
      if (warnedThisYear.has(key)) continue;
      warnedThisYear.add(key);
      warnings.push({
        year,
        kind: "insufficient_funds",
        accountId: account.id,
        message: `${account.name} runs negative starting ${month}.`,
      });
    }

    // 8. Period finalization -- the annual snapshot (in December), then this
    //    month's snapshot if it falls in the monthly drill-down window.
    const nextMonth = i + 1 < simulationMonths.length ? simulationMonths[i + 1] : null;
    const isLastMonthOfYear = !nextMonth || yearOf(nextMonth) !== yearOf(month);
    // Set in December and reused by BOTH that year's annual row and
    // December's own monthly row, so the twelve monthly rows still carry the
    // full year's exact tax bill exactly once between them.
    let exactTax = NO_EXACT_TAX;
    if (isLastMonthOfYear) {
      // NOTE ON ORDER: the exact federal bill is computed FIRST, then the
      // withholding-vs-exact true-up is posted to the hub and a refund routed
      // through the split order, and only then are rollforwards, net worth,
      // and the hub delta measured -- so every ending figure already includes
      // both the settlement and its routing.
      const withdrawalsByAccount = withdrawalItems(acc);

      // Exact federal tax for the year, from real 2026 brackets on the year's
      // actually-realized income -- independent of however approximate the
      // rate used to size withholding during the monthly loop above was.
      const grossOrdinaryWithdrawals = withdrawalsByAccount
        .filter((w) => w.taxTreatment === "tax_deferred")
        .reduce((s, w) => s + w.gross, 0);
      // Any gross salary opted in via IncomeSource.grossAmount (0 otherwise,
      // the historical behavior) -- included in the SS-taxability test and
      // bracket placement below, but never itself taxed by this engine.
      const grossSalary = acc.grossSalary;
      const taxableSocialSecurityAmount = taxableSocialSecurity(
        acc.grossSocialSecurity,
        grossOrdinaryWithdrawals + acc.grossPension + grossSalary,
        settings.filingStatus
      );
      // Denominator for the tax_deferred/pension/SS component split below --
      // deliberately excludes salary, since federalOrdinaryTax (computed
      // further down) is already the INCREMENTAL tax due to just these three
      // sources, stacked on top of salary's own bracket position.
      const grossOrdinaryIncome = grossOrdinaryWithdrawals + acc.grossPension + taxableSocialSecurityAmount;
      const standardDeduction = standardDeductionForYear(
        scenario.household.people,
        settings.filingStatus,
        currentYear,
        settings.inflationRatePct,
        grossOrdinaryIncome + grossSalary
      );
      // ordinaryTaxableIncome is the FULL taxable base (salary + withdrawals
      // + pension + taxable SS) -- this is what capital gains and other
      // ordinary income genuinely stack on top of in the real tax code, and
      // what the next iteration's estimated withholding rate should reflect
      // (see projectScenario's convergence loop, which reads this field).
      const ordinaryTaxableIncome = Math.max(0, grossOrdinaryIncome + grossSalary - standardDeduction);
      // salaryTaxableIncome is salary's own slice of that base (deduction
      // applied to salary first) -- subtracted below so salary's own tax,
      // already assumed paid via take-home withholding, is never charged
      // again by this engine; only the INCREMENT due to withdrawals/pension/
      // SS/capital-gains is.
      const salaryTaxableIncome = Math.max(0, grossSalary - standardDeduction);
      const { ordinary: ordinaryBrackets, ltcg: ltcgBrackets } = bracketsForYear(
        currentYear,
        settings.filingStatus,
        settings.inflationRatePct
      );
      const federalOrdinaryTax =
        progressiveTax(ordinaryTaxableIncome, ordinaryBrackets) - progressiveTax(salaryTaxableIncome, ordinaryBrackets);
      const { tax: federalLtcgTax } = stackedLtcgTax(ordinaryTaxableIncome, acc.capitalGainsRealized, ltcgBrackets);
      // The flat add-on (state/local, or anything else not modeled) applies
      // to the same incremental (non-salary) base as federalOrdinaryTax; 0 by
      // default (e.g. correct as-is in a no-income-tax state).
      const additionalTax =
        (ordinaryTaxableIncome - salaryTaxableIncome + acc.capitalGainsRealized) * settings.additionalFlatTaxRatePct;
      // The 10% early-withdrawal penalty is a flat excise on the withdrawn
      // amount, not bracket-dependent -- the amount charged during the
      // monthly loop IS the exact figure, so it joins the exact bill as-is.
      const federalTaxTotal = federalOrdinaryTax + federalLtcgTax + additionalTax + acc.earlyWithdrawalPenalties;

      // Allocate the ordinary-income tax pro-rata across its gross sources so
      // the breakdown ties out exactly to federalTaxTotal, however the year's
      // ordinary tax happens to be split across withdrawals/pension/SS.
      const [taxDeferredTax, pensionTax, taxableSocialSecurityTax] =
        grossOrdinaryIncome > 0
          ? [
              federalOrdinaryTax * (grossOrdinaryWithdrawals / grossOrdinaryIncome),
              federalOrdinaryTax * (acc.grossPension / grossOrdinaryIncome),
              federalOrdinaryTax * (taxableSocialSecurityAmount / grossOrdinaryIncome),
            ]
          : [0, 0, 0];
      const capitalGainsTax = federalLtcgTax;
      const stateLocalAddOn = additionalTax;
      const federalTaxByComponent = (
        [
          { key: "tax_deferred", label: "Tax on tax-deferred withdrawals & RMDs", amount: taxDeferredTax },
          { key: "pension", label: "Tax on pension income", amount: pensionTax },
          { key: "taxable_social_security", label: "Tax on taxable Social Security", amount: taxableSocialSecurityTax },
          { key: "capital_gains", label: "Capital gains tax", amount: capitalGainsTax },
          { key: "early_withdrawal_penalty", label: "Early-withdrawal penalty (10%, pre-59½)", amount: acc.earlyWithdrawalPenalties },
          { key: "state_local", label: "State/local add-on", amount: stateLocalAddOn },
        ] as const
      ).filter((c) => c.amount > 0.005);

      // --- Year-end tax true-up -----------------------------------------
      // The monthly loop withheld ESTIMATED tax (marginal rate on every
      // dollar, no standard deduction). Settle the difference against the
      // exact bracket bill so the household's actual cash tax for the year
      // equals federalTaxTotal exactly: refund over-withholding to the hub,
      // charge any shortfall from it. Skipped when no rate table was
      // supplied (raw untaxed engine runs, e.g. most unit tests).
      if (ratesByYearOverride !== undefined && extraSavingsAccount) {
        const settlement = acc.taxesPaid - federalTaxTotal;
        if (Math.abs(settlement) > 0.005) {
          const hubId = extraSavingsAccount.id;
          balances.set(hubId, (balances.get(hubId) ?? 0) + settlement);
          const hubBucket = acc.rollforward.get(hubId)!;
          if (settlement >= 0) hubBucket.deposits += settlement;
          else hubBucket.withdrawals += -settlement;
          acc.taxSettlement = settlement;
          ledger.push({
            date: month,
            kind: "tax_settlement",
            accountId: hubId,
            amount: settlement,
            note:
              settlement >= 0
                ? `Tax true-up refund (withheld ${Math.round(acc.taxesPaid)} vs actual bill ${Math.round(federalTaxTotal)})`
                : `Tax true-up payment (withheld ${Math.round(acc.taxesPaid)} vs actual bill ${Math.round(federalTaxTotal)})`,
          });
          // A refund is surplus cash like any other, so route it through the
          // fill order now. Step 5 already ran for December and the
          // fresh-surplus rule means no later month will ever re-offer it --
          // without this it sits in the hub as idle cash indefinitely, which
          // reads as "Extra Savings mysteriously accumulating a balance".
          // Clamped to the hub's actual balance so a reserve deliberately
          // left unclaimed in an earlier month is never swept along with it.
          if (settlement > 0) {
            routeThroughSplitOrder(Math.min(settlement, balances.get(hubId) ?? 0));
          }
        }
      }

      exactTax = { federalTaxTotal, federalTaxByComponent: [...federalTaxByComponent], ordinaryTaxableIncome, taxableSocialSecurityAmount };

      // --- Everything below reads balances AFTER the settlement ----------
      years.push(
        buildPeriodSnapshot(
          "year",
          String(currentYear),
          String(currentYear),
          endOfYear(currentYear),
          `${currentYear}-07-01`,
          currentYear,
          acc,
          yearStartBalances,
          exactTax
        )
      );
    }

    // 8b. This month's snapshot, built by differencing the accumulator against
    //     its state at the start of the month. Runs AFTER the annual block so
    //     December's row already includes the tax settlement -- otherwise the
    //     twelve monthly rows wouldn't sum to the annual row.
    if (inMonthlyWindow) {
      months.push(
        buildPeriodSnapshot(
          "month",
          yearMonth,
          monthColumnLabel(yearMonth),
          endOfMonth(yearMonth),
          midMonth(yearMonth),
          yearOf(month),
          diffAccumulator(accAtMonthStart, acc),
          monthStartBalances,
          exactTax
        )
      );
    }

    // 8c. Roll the year forward (after both snapshots have been taken).
    if (isLastMonthOfYear) {
      for (const [id, balance] of balances) priorYearEndBalances.set(id, balance);
      for (const [id, balance] of balances) yearStartBalances.set(id, balance);
      if (nextMonth) currentYear = yearOf(nextMonth);
      acc = freshAccumulator(accountIds);
    }
  }

  const retireEvents = scenario.events
    .filter((e) => e.type === "retire" && !e.isExcluded)
    .sort((a, b) => compareDates(a.startDate, b.startDate));
  const firstRetire = retireEvents[0];
  let netWorthAtRetirement: number | null = null;
  let netWorthAtRetirementReal: number | null = null;
  let retirementAge: number | null = null;
  if (firstRetire && firstRetire.type === "retire") {
    const retireYear = yearOf(firstRetire.startDate);
    const snapshot = years.find((y) => y.year === retireYear);
    netWorthAtRetirement = snapshot ? snapshot.netWorthNominal : null;
    netWorthAtRetirementReal = snapshot ? snapshot.netWorthReal : null;
    const person = scenario.household.people.find((p) => p.id === firstRetire.personId);
    retirementAge = person ? ageOn(person.birthDate, firstRetire.startDate) : null;
  }

  const unlinkedMortgages = activeAccounts.filter((a) => a.class === "mortgage" && !a.loanTerms?.linkedAssetId);
  for (const m of unlinkedMortgages) {
    warnings.unshift({ year: yearOf(m.effectiveStartDate), kind: "unlinked_mortgage", accountId: m.id, message: `${m.name} has no linked real estate asset.` });
  }
  // A carried debt with no payoff plan just sits frozen forever (no interest,
  // no payments) -- flag it so the user knows the projection is ignoring it.
  const unamortizedDebts = activeAccounts.filter(
    (a) => (a.class === "credit_card" || a.class === "loan") && a.startingBalance > 0 && !a.loanTerms
  );
  for (const d of unamortizedDebts) {
    warnings.unshift({
      year: yearOf(d.effectiveStartDate),
      kind: "unamortized_debt",
      accountId: d.id,
      message: `${d.name} has a balance but no interest rate/term -- it will sit frozen (no interest, no payments) until you add loan details.`,
    });
  }

  return {
    scenarioId: scenario.id,
    computedAt: new Date().toISOString(),
    accounts,
    years,
    months,
    timeline: resolved.timeline,
    ledger,
    kpis: {
      netWorthEndOfYear1: years[0]?.netWorthNominal ?? 0,
      netWorthEndOfYear1Real: years[0]?.netWorthReal ?? 0,
      netWorthAtRetirement,
      netWorthAtRetirementReal,
      retirementAge,
      netWorthAtEnd: years[years.length - 1]?.netWorthNominal ?? 0,
      netWorthAtEndReal: years[years.length - 1]?.netWorthReal ?? 0,
    },
    warnings,
  };
}

const MAX_TAX_CONVERGENCE_ITERATIONS = 3;
/** Stop iterating once no year's rate moves by more than this (0.1 percentage point). */
const RATE_CONVERGENCE_TOLERANCE = 0.001;

/**
 * The real entry point for the app (see useProjection.ts): runs
 * `forecastScenario` repeatedly, refining each year's withdrawal/withholding
 * rate estimate from that year's own actual realized income each time, until
 * the estimates stop moving (or the iteration cap is hit -- this is a
 * well-behaved monotonic function, converges in 1-2 passes almost always).
 * Because the simulation is deterministic (no Monte Carlo), a whole year's
 * income picture is fully knowable, so this whole-horizon iteration is
 * simpler and more robust than trying to solve each year's tax circularity
 * inline. The final pass's result -- already carrying the exact
 * bracket-computed `federalTaxTotal` per year -- is returned as-is.
 */
export function projectScenario(scenario: Scenario): ProjectionResult {
  // Same null-means-today resolution as forecastScenario -- needed here too
  // since startYear/endYear (for the tax-rate map below) are computed
  // before forecastScenario ever runs.
  const settings = { ...scenario.settings, startDate: scenario.settings.startDate ?? todayISO() };
  const startYear = yearOf(settings.startDate);
  const endYear = yearOf(settings.horizonEndDate);

  let ratesByYear = new Map<number, YearTaxRates>();
  for (let y = startYear; y <= endYear; y++) ratesByYear.set(y, SEED_TAX_RATES);

  let result = forecastScenario(scenario, ratesByYear);

  for (let iteration = 0; iteration < MAX_TAX_CONVERGENCE_ITERATIONS; iteration++) {
    const nextRates = new Map<number, YearTaxRates>();
    let maxDelta = 0;

    for (const snapshot of result.years) {
      const prev = ratesByYear.get(snapshot.year) ?? SEED_TAX_RATES;
      const { ordinary, ltcg } = bracketsForYear(snapshot.year, settings.filingStatus, settings.inflationRatePct);
      const nextOrdinary = marginalRate(snapshot.cashFlow.ordinaryTaxableIncome, ordinary);
      const { marginalRate: nextLtcg } = stackedLtcgTax(
        snapshot.cashFlow.ordinaryTaxableIncome,
        snapshot.cashFlow.capitalGainsRealized,
        ltcg
      );
      const nextSsFraction =
        snapshot.cashFlow.grossSocialSecurity > 0
          ? snapshot.cashFlow.taxableSocialSecurityAmount / snapshot.cashFlow.grossSocialSecurity
          : prev.ssTaxableFraction;

      maxDelta = Math.max(
        maxDelta,
        Math.abs(nextOrdinary - prev.ordinaryMarginalRate),
        Math.abs(nextLtcg - prev.ltcgMarginalRate)
      );
      nextRates.set(snapshot.year, {
        ordinaryMarginalRate: nextOrdinary,
        ltcgMarginalRate: nextLtcg,
        ssTaxableFraction: nextSsFraction,
      });
    }

    ratesByYear = nextRates;
    if (maxDelta < RATE_CONVERGENCE_TOLERANCE) break;
    result = forecastScenario(scenario, ratesByYear);
  }

  return result;
}
