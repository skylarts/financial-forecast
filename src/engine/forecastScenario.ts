import type {
  Id,
  ISODate,
  Scenario,
  ForecastSettings,
  AccountYearRollforward,
  CashFlowYearRow,
  YearSnapshot,
  ProjectionResult,
  ProjectionWarning,
  LedgerEvent,
  SplitStop,
  DrainStop,
} from "@/domain";
import { ageOn, compareDates, eachMonthStart, endOfYear, yearOf } from "./dateMath";
import { monthlyRateFromAnnual } from "./growth";
import { rmdDivisor } from "./rmd";
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
  /** Taxes paid on RMDs and shortfall withdrawals (cash leaving the household). */
  taxesPaid: number;
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
    taxesPaid: 0,
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
  };
}

function addTo(map: Map<Id, number>, key: Id, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function effectiveAnnualRate(account: EngineAccount, month: string): number {
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
  return account.growthRatePct;
}

/**
 * The surplus-routing ceiling for a fill-order stop in a given year. Uncapped
 * stops return Infinity (they absorb everything). Capped stops grow their
 * ceiling yearly by maxBalanceGrowthRatePct, defaulting to inflation, so the
 * cap keeps pace in real terms over a long horizon.
 */
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

function effectiveMaxBalance(stop: SplitStop, yearsSinceStart: number, inflationRatePct: number): number {
  if (stop.maxBalance == null) return Infinity;
  const rate = stop.maxBalanceGrowthRatePct ?? inflationRatePct;
  return stop.maxBalance * Math.pow(1 + rate, Math.max(0, yearsSinceStart));
}

/** Mirrors effectiveMaxBalance's inflation handling, so a drain floor stays a "today's dollars" amount. */
function effectiveDrainFloor(stop: DrainStop, yearsSinceStart: number, inflationRatePct: number): number {
  if (stop.minBalance == null) return 0;
  const rate = stop.minBalanceGrowthRatePct ?? inflationRatePct;
  return stop.minBalance * Math.pow(1 + rate, Math.max(0, yearsSinceStart));
}

/**
 * How a withdrawal from this account is taxed. Prefers the explicit
 * taxTreatment, but falls back to the account class when it's left at "n/a"
 * (default) -- so a brokerage / traditional / Roth account is taxed correctly
 * even if the user never set the treatment field.
 */
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
  const { settings } = scenario;
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
  const splitStops = moneyFlow.splitOrder
    .map((stop) => {
      const account = accountById.get(stop.accountId);
      return account && !account.isExcluded ? { account, stop } : null;
    })
    .filter((x): x is { account: EngineAccount; stop: SplitStop } => x !== null);
  const drainStops = moneyFlow.drainOrder
    .map((stop) => {
      const account = accountById.get(stop.accountId);
      return account && account.category === "asset" && !account.isExcluded ? { account, stop } : null;
    })
    .filter((x): x is { account: EngineAccount; stop: DrainStop } => x !== null);
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

  const years: YearSnapshot[] = [];
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

  let currentYear = yearOf(settings.startDate);
  let acc = freshAccumulator(accountIds);
  const yearStartBalances = new Map<Id, number>(balances);

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
    if (treatment === "tax_deferred") return rates.ordinaryMarginalRate;
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
  // that actually reached `spender` -- the single primitive both drain-order
  // modes (priority_fill and fixed_split) draw from.
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

  const months = [...eachMonthStart(settings.startDate, settings.horizonEndDate)];

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const yearMonth = month.slice(0, 7);
    const isJanuary = month.endsWith("-01-01");

    // Captured BEFORE this month's growth/postings/mortgages/RMDs run, so the
    // surplus split (step 5) can size itself off exactly this month's FRESH
    // inflow to Extra Savings -- see step 5 for why that distinction matters.
    const extraSavingsMonthStart = extraSavingsAccount ? balances.get(extraSavingsAccount.id) ?? 0 : 0;

    // 1. Growth (skipped in an account's creation month -- mirrors the
    //    proven prior engine's "no interest on day one" rule -- and skipped
    //    entirely for excluded accounts, which stay frozen at their starting
    //    balance once set).
    for (const account of accounts) {
      if (compareDates(month, account.effectiveStartDate) < 0) continue;
      const isCreationMonth = month.slice(0, 7) === account.effectiveStartDate.slice(0, 7);
      if (isCreationMonth) {
        // The opening balance is the account's starting balance for its first
        // year -- surface it in the "Starting balance" rollforward row rather
        // than counting it as a deposit.
        balances.set(account.id, account.startingBalance);
        yearStartBalances.set(account.id, account.startingBalance);
        basis.set(account.id, account.startingBalance);
        continue;
      }
      if (account.isExcluded) continue;
      if (account.class === "credit_card" || account.class === "loan" || account.class === "mortgage") continue;
      const rate = monthlyRateFromAnnual(effectiveAnnualRate(account, month));
      if (!rate) continue;
      const growthAmount = (balances.get(account.id) ?? 0) * rate;
      balances.set(account.id, (balances.get(account.id) ?? 0) + growthAmount);
      acc.rollforward.get(account.id)!.growth += growthAmount;
    }

    // 2. Scheduled cashflows for this month. (resolveEvents already omits
    //    postings targeting an excluded account; this check is a cheap backstop.)
    for (const posting of postingsByMonth.get(yearMonth) ?? []) {
      const targetAccount = accountById.get(posting.accountId);
      if (targetAccount?.isExcluded) continue;
      if (compareDates(month, (targetAccount?.effectiveStartDate ?? month)) < 0) continue;
      balances.set(posting.accountId, (balances.get(posting.accountId) ?? 0) + posting.amount);
      const bucket = acc.rollforward.get(posting.accountId);
      if (bucket) {
        if (posting.amount >= 0) bucket.deposits += posting.amount;
        else bucket.withdrawals += -posting.amount;
      }
      if (posting.category === "income") {
        acc.totalIncome += posting.amount;
        addTo(acc.incomeByItem, posting.sourceId, posting.amount);
        itemLabels.set(posting.sourceId, posting.label);
        markFirstDate(posting.sourceId, posting.date);
        // Income landing straight in a non-hub account (e.g. a windfall
        // deposited to a brokerage) still counts in totalIncome for the
        // itemized list, but never reached cash on hand -- track separately
        // so it doesn't inflate the reconciled Net.
        if (!hubIds.has(posting.accountId)) acc.directIncomeToOtherAccounts += posting.amount;

        // Social Security and pension income are entered GROSS (unlike every
        // other income category, which is take-home) so their real
        // taxability can be computed -- withhold an estimate now at this
        // year's converged rate; the exact bracket-computed bill overrides
        // this at year-end regardless (see federalTaxTotal below).
        const incomeSrc = incomeSourceById.get(posting.sourceId);
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
      }
      // contribution_out: balance + rollforward already handled above.
      // A non-hub-touching transfer leg needs no extra bookkeeping here --
      // outflows from a non-hub asset account are captured as withdrawals below.

      // Any outflow from a taxable / tax-deferred account (a transfer out, or an
      // expense paid straight from it) is a sale that realizes tax.
      if (posting.amount < 0) {
        const outAmount = -posting.amount;
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

    // 3. Amortize mortgages/loans.
    for (const account of accounts) {
      if (account.isExcluded) continue;
      if (account.class !== "mortgage" && account.class !== "loan") continue;
      if (compareDates(month, account.effectiveStartDate) < 0) continue;
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
        balances.set(payerId, (balances.get(payerId) ?? 0) - actualPayment);
        const payerBucket = acc.rollforward.get(payerId);
        if (payerBucket) payerBucket.withdrawals += actualPayment;
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
    if (isJanuary) {
      const year = yearOf(month);
      for (const account of accounts) {
        if (account.isExcluded || !account.subjectToRMD || !account.ownerId) continue;
        // Roth accounts (401k or IRA) are never subject to RMDs during the
        // owner's life -- SECURE 2.0 eliminated the old Roth 401(k) RMD rule
        // starting in 2024. Guard here regardless of the checkbox above, since
        // a Roth 401(k) is easy to mis-set as class="tax_deferred" (it's still
        // a "401k") while carrying taxTreatment="tax_free".
        if (effectiveTaxTreatment(account) === "tax_free") continue;
        if (compareDates(month, account.effectiveStartDate) < 0) continue;
        const owner = scenario.household.people.find((p) => p.id === account.ownerId);
        if (!owner) continue;
        const age = ageOn(owner.birthDate, endOfYear(year));
        const divisor = rmdDivisor(age);
        const priorBalance = priorYearEndBalances.get(account.id) ?? 0;
        if (!divisor || priorBalance <= 0) continue;
        const rmdAmount = priorBalance / divisor;
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
    if (extraSavingsAccount) {
      const freshSurplus = (balances.get(extraSavingsAccount.id) ?? 0) - extraSavingsMonthStart;
      let remaining = freshSurplus;
      for (const { account: target, stop } of activeSplitStops) {
        if (remaining <= 0.005) break;
        if (target.id === extraSavingsAccount.id) continue;
        const cap = effectiveMaxBalance(stop, yearsSinceStart, settings.inflationRatePct);
        const room = cap - (balances.get(target.id) ?? 0);
        if (room <= 0) continue; // target already at/over its ceiling -- spill onward
        const offered = stop.kind === "flat" ? (stop.amount ?? 0) * inflationFactor : remaining * (stop.pct ?? 0);
        const take = Math.min(offered, room, remaining);
        if (take <= 0) continue;
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
    }

    // 5b. Cap overflow. The split above only catches money entering a target
    //     from Extra Savings. A target can also exceed its cap via a custom
    //     transfer landing on it directly, income deposited straight into it,
    //     or its own organic growth. So: for every split stop currently above
    //     its cap, walk later stops in list order and push the excess down
    //     the chain, landing wherever there's room. This is a rebalance
    //     between the user's own accounts, so it's recorded in rollforwards
    //     (balances must still reconcile) but explicitly NOT counted in the
    //     surplusRouted headline, which tracks routed income only. Uses the
    //     same active (date-window) subset as the split above.
    for (let ti = 0; ti < activeSplitStops.length; ti++) {
      const over = activeSplitStops[ti];
      const overCap = effectiveMaxBalance(over.stop, yearsSinceStart, settings.inflationRatePct);
      let excess = (balances.get(over.account.id) ?? 0) - overCap;
      if (excess <= 0.005) continue;
      for (let tj = ti + 1; tj < activeSplitStops.length && excess > 0.005; tj++) {
        const dest = activeSplitStops[tj];
        const destCap = effectiveMaxBalance(dest.stop, yearsSinceStart, settings.inflationRatePct);
        const room = destCap - (balances.get(dest.account.id) ?? 0);
        if (room <= 0) continue; // next target also full -- keep spilling onward
        const move = Math.min(excess, room);
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
    //    docs: Extra Savings has no floor/ceiling input of its own). Only
    //    drain stops whose optional date window covers this month participate
    //    -- lets e.g. a brokerage fund a shortfall for a few years until a
    //    later account becomes the active source.
    if (extraSavingsAccount) {
      const spender = extraSavingsAccount;
      let shortfall = 0 - (balances.get(spender.id) ?? 0);
      if (shortfall > 0) {
        const active = drainStops.filter(({ stop }) => isDrainStopActive(stop, month));
        const totalSplit = active.reduce((s, { stop }) => s + (stop.splitPct ?? 0), 0);

        if (moneyFlow.drainSplitMode === "fixed_split" && totalSplit > 0) {
          // Pass 1: each active source's target share of the ORIGINAL
          // shortfall (not a shrinking remainder, so ratios stay meaningful
          // regardless of draw order).
          const originalShortfall = shortfall;
          for (const { account: source, stop } of active) {
            const target = originalShortfall * ((stop.splitPct ?? 0) / totalSplit);
            const floor = effectiveDrainFloor(stop, yearsSinceStart, settings.inflationRatePct);
            shortfall -= drawFromSource(source, spender, target, month, floor);
          }
          // Pass 2: top up any unmet remainder from active sources in list
          // order -- the split is a target ratio, not a hard cap, so the
          // shortfall still gets fully covered whenever the combined active
          // balance allows it, rather than leaving the household short
          // because one bucket ran low this month.
          for (const { account: source, stop } of active) {
            if (shortfall <= 0) break;
            const floor = effectiveDrainFloor(stop, yearsSinceStart, settings.inflationRatePct);
            shortfall -= drawFromSource(source, spender, shortfall, month, floor);
          }
        } else {
          // priority_fill (default): drain each active source fully (down to
          // its floor) before moving to the next, in list order.
          for (const { account: source, stop } of active) {
            if (shortfall <= 0) break;
            const floor = effectiveDrainFloor(stop, yearsSinceStart, settings.inflationRatePct);
            shortfall -= drawFromSource(source, spender, shortfall, month, floor);
          }
        }
      }
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

    // 8. Year finalization.
    const nextMonth = i + 1 < months.length ? months[i + 1] : null;
    const isLastMonthOfYear = !nextMonth || yearOf(nextMonth) !== yearOf(month);
    if (isLastMonthOfYear) {
      const rollforwards: AccountYearRollforward[] = accounts.map((account) => {
        const bucket = acc.rollforward.get(account.id)!;
        const startingBalance = yearStartBalances.get(account.id) ?? 0;
        const endingBalance = balances.get(account.id) ?? 0;
        return {
          accountId: account.id,
          year: currentYear,
          startingBalance,
          inflationAdjustment: 0, // folded into growth/deposits per-posting; see forecast engine spec
          growth: bucket.growth,
          deposits: bucket.deposits,
          withdrawals: bucket.withdrawals,
          endingBalance,
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
      const cumulativeInflation = Math.pow(1 + settings.inflationRatePct, currentYear - yearOf(settings.startDate));
      const netWorthReal = netWorthNominal / cumulativeInflation;

      // "Cash on hand" is the total balance across every class="cash" account
      // (Extra Savings, checking, an emergency fund, etc.) -- broader than
      // the money-flow hub used elsewhere for withdrawal/transfer
      // categorization, since a surplus swept from the hub into checking or
      // an emergency fund is still cash, not withdrawn or invested. Because
      // it spans multiple accounts rather than measuring one hub's balance
      // delta, "Net change in cash" below is no longer guaranteed to
      // reconcile exactly to the itemized rows above it -- any gap is real
      // cash movement between hub and non-hub cash accounts that isn't
      // separately itemized elsewhere on this statement.
      const hubCashStart = [...cashAccountIds].reduce((s, id) => s + (yearStartBalances.get(id) ?? 0), 0);
      const endingCashBalance = [...cashAccountIds].reduce((s, id) => s + (balances.get(id) ?? 0), 0);
      const hubCashInterest = [...cashAccountIds].reduce((s, id) => s + (acc.rollforward.get(id)?.growth ?? 0), 0);

      // Sorted line-item arrays; labels come from itemLabels (posting/mortgage
      // ids) or the account name (for account-keyed maps).
      const toLineItems = (map: Map<Id, number>) =>
        [...map.entries()]
          .map(([id, amount]) => ({ id, label: itemLabels.get(id) ?? id, amount, startDate: itemFirstDate.get(id) ?? null }))
          .sort((a, b) => b.amount - a.amount);
      const toAccountItems = (map: Map<Id, number>) =>
        [...map.entries()]
          .filter(([, amount]) => amount > 0.005)
          .map(([id, amount]) => ({ id, label: accountById.get(id)?.name ?? id, amount, startDate: null }))
          .sort((a, b) => b.amount - a.amount);

      // Unify every account outflow (drawdowns, RMDs, direct payments) into one
      // gross/net/tax line per source account, for the Withdrawals section.
      const withdrawalAccountIds = new Set<Id>([
        ...acc.withdrawalNetByAccount.keys(),
        ...acc.withdrawalTaxByAccount.keys(),
      ]);
      const withdrawalsByAccount = [...withdrawalAccountIds]
        .map((id) => {
          const net = acc.withdrawalNetByAccount.get(id) ?? 0;
          const tax = acc.withdrawalTaxByAccount.get(id) ?? 0;
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

      // Exact federal tax for the year, from real 2026 brackets on the year's
      // actually-realized income -- independent of however approximate the
      // rate used to size withholding during the monthly loop above was.
      const grossOrdinaryWithdrawals = withdrawalsByAccount
        .filter((w) => w.taxTreatment === "tax_deferred")
        .reduce((s, w) => s + w.gross, 0);
      const taxableSocialSecurityAmount = taxableSocialSecurity(
        acc.grossSocialSecurity,
        grossOrdinaryWithdrawals + acc.grossPension,
        settings.filingStatus
      );
      const grossOrdinaryIncome = grossOrdinaryWithdrawals + acc.grossPension + taxableSocialSecurityAmount;
      const standardDeduction = standardDeductionForYear(
        scenario.household.people,
        settings.filingStatus,
        currentYear,
        settings.inflationRatePct,
        grossOrdinaryIncome
      );
      const ordinaryTaxableIncome = Math.max(0, grossOrdinaryIncome - standardDeduction);
      const { ordinary: ordinaryBrackets, ltcg: ltcgBrackets } = bracketsForYear(
        currentYear,
        settings.filingStatus,
        settings.inflationRatePct
      );
      const federalOrdinaryTax = progressiveTax(ordinaryTaxableIncome, ordinaryBrackets);
      const { tax: federalLtcgTax } = stackedLtcgTax(ordinaryTaxableIncome, acc.capitalGainsRealized, ltcgBrackets);
      // The flat add-on (state/local, or anything else not modeled) applies
      // to the same combined base; 0 by default (e.g. correct as-is in a
      // no-income-tax state).
      const additionalTax =
        (ordinaryTaxableIncome + acc.capitalGainsRealized) * settings.additionalFlatTaxRatePct;
      const federalTaxTotal = federalOrdinaryTax + federalLtcgTax + additionalTax;

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
          { key: "state_local", label: "State/local add-on", amount: stateLocalAddOn },
        ] as const
      ).filter((c) => c.amount > 0.005);

      const operatingCashFlow = acc.totalIncome - acc.totalExpenses;
      // Cash that flowed in from accounts to cover the operating gap: deficit
      // draws + RMD proceeds, plus any expense paid directly from an investment
      // (which offsets that expense, since cash was never touched).
      const withdrawalsToCashNet = acc.deficitCovered + acc.rmdTotal + acc.directExpenseFromAccounts;
      // Edge-case bucket: transfers touching the hub directly, net of income
      // that bypassed the hub entirely. Zero in the common case where income
      // lands on and expenses pay from the hub with no direct hub transfers.
      const otherAccountActivity = acc.hubTransferNet - acc.directIncomeToOtherAccounts;
      // Ground truth: the hub's actual measured balance change this year.
      // Always exactly right, regardless of which mechanism moved the money.
      const netCashFlow = endingCashBalance - hubCashStart;

      const cashFlow: CashFlowYearRow = {
        year: currentYear,
        totalIncome: acc.totalIncome,
        totalExpenses: acc.totalExpenses,
        operatingCashFlow,
        netCashFlow,
        surplusRouted: acc.surplusRouted,
        withdrawalsToCashNet,
        rmdTotal: acc.rmdTotal,
        withdrawalTaxes: acc.taxesPaid,
        cashInterest: hubCashInterest,
        otherAccountActivity,
        endingCashBalance,
        afterTaxContributionTotal: acc.afterTaxContributions,
        incomeByItem: toLineItems(acc.incomeByItem),
        expenseByItem: toLineItems(acc.expenseByItem),
        contributionsByItem: [...acc.contributionsByItem.entries()]
          .map(([id, amount]) => ({
            id,
            label: itemLabels.get(id) ?? id,
            amount,
            startDate: itemFirstDate.get(id) ?? null,
            fromPaycheck: contributionFromPaycheck.get(id) ?? false,
          }))
          .sort((a, b) => b.amount - a.amount),
        surplusByAccount: toAccountItems(acc.surplusByAccount),
        withdrawalsByAccount,
        federalTaxTotal,
        federalTaxByComponent,
        ordinaryTaxableIncome,
        capitalGainsRealized: acc.capitalGainsRealized,
        grossSocialSecurity: acc.grossSocialSecurity,
        taxableSocialSecurityAmount,
      };

      years.push({
        year: currentYear,
        date: endOfYear(currentYear),
        totalAssetsNominal,
        totalLiabilitiesNominal,
        netWorthNominal,
        netWorthReal,
        inflationDeflator: cumulativeInflation,
        accountBalances: Object.fromEntries(balances),
        rollforwards,
        cashFlow,
      });

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

  return {
    scenarioId: scenario.id,
    computedAt: new Date().toISOString(),
    accounts,
    years,
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
  const { settings } = scenario;
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
