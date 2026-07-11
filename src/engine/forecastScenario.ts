import type {
  Id,
  Scenario,
  AccountYearRollforward,
  CashFlowYearRow,
  YearSnapshot,
  ProjectionResult,
  ProjectionWarning,
  LedgerEvent,
  WithdrawalTaxRates,
  MoneyFlowStop,
} from "@/domain";
import { ageOn, compareDates, eachMonthStart, endOfYear, yearOf } from "./dateMath";
import { monthlyRateFromAnnual } from "./growth";
import { rmdDivisor } from "./rmd";
import { computeMonthlyPayment, amortizeMonth } from "./amortization";
import { resolveEvents } from "./resolveEvents";
import { resolvePrimarySpendingAccountId } from "./moneyFlow";
import type { EngineAccount, MortgageSpec, Posting } from "./types";

interface YearAccumulator {
  rollforward: Map<Id, { growth: number; deposits: number; withdrawals: number }>;
  totalIncome: number;
  totalExpenses: number;
  surplusRouted: number;
  deficitCovered: number;
  rmdTotal: number;
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
  /** Shortfall draws pulled from each source account, keyed by accountId. */
  withdrawalsByAccount: Map<Id, number>;
  /** RMD draws from each account, keyed by accountId. */
  rmdByAccount: Map<Id, number>;
}

function freshAccumulator(accountIds: Id[]): YearAccumulator {
  return {
    rollforward: new Map(accountIds.map((id) => [id, { growth: 0, deposits: 0, withdrawals: 0 }])),
    totalIncome: 0,
    totalExpenses: 0,
    surplusRouted: 0,
    deficitCovered: 0,
    rmdTotal: 0,
    taxesPaid: 0,
    afterTaxContributions: 0,
    incomeByItem: new Map(),
    expenseByItem: new Map(),
    contributionsByItem: new Map(),
    surplusByAccount: new Map(),
    withdrawalsByAccount: new Map(),
    rmdByAccount: new Map(),
  };
}

function addTo(map: Map<Id, number>, key: Id, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function effectiveAnnualRate(account: EngineAccount, month: string): number {
  // A growth_rate_change event overrides everything else once it's started --
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
function effectiveMaxBalance(stop: MoneyFlowStop, yearsSinceStart: number, inflationRatePct: number): number {
  if (stop.maxBalance == null) return Infinity;
  const rate = stop.maxBalanceGrowthRatePct ?? inflationRatePct;
  return stop.maxBalance * Math.pow(1 + rate, Math.max(0, yearsSinceStart));
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

/** Effective tax rate on withdrawing from this account, by its tax treatment. */
function withdrawalTaxRate(account: EngineAccount, rates: WithdrawalTaxRates | undefined): number {
  if (!rates) return 0;
  switch (effectiveTaxTreatment(account)) {
    case "tax_deferred":
      return rates.taxDeferredPct;
    case "taxable":
      return rates.taxablePct;
    case "tax_free":
      return rates.taxFreePct;
    default:
      return 0;
  }
}

export function forecastScenario(scenario: Scenario): ProjectionResult {
  const { settings } = scenario;
  const moneyFlow = settings.moneyFlow;
  const taxRates = settings.withdrawalTaxRates;
  const resolved = resolveEvents(scenario);
  const accounts = resolved.accounts;
  const accountIds = accounts.map((a) => a.id);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
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
  // hubs are the spending accounts (each with its own buffer), fillOrder is
  // the ordered surplus-target chain, drainOrder is the ordered deficit
  // cascade. List order IS the priority -- no numeric priority fields anymore.
  const spendingHubs = moneyFlow.hubs
    .map((hub) => {
      const account = accountById.get(hub.accountId);
      return account && !account.isExcluded ? { account, hub } : null;
    })
    .filter((x): x is { account: EngineAccount; hub: (typeof moneyFlow.hubs)[number] } => x !== null);
  const fillStops = moneyFlow.fillOrder
    .map((stop) => {
      const account = accountById.get(stop.accountId);
      return account && !account.isExcluded ? { account, stop } : null;
    })
    .filter((x): x is { account: EngineAccount; stop: MoneyFlowStop } => x !== null);
  const cascadeSources = moneyFlow.drainOrder
    .map((id) => accountById.get(id))
    .filter((a): a is EngineAccount => !!a && a.category === "asset" && !a.isExcluded);
  const primarySpendingAccountId = resolvePrimarySpendingAccountId(activeAccounts, moneyFlow);

  const balances = new Map<Id, number>(accounts.map((a) => [a.id, 0]));
  const priorYearEndBalances = new Map<Id, number>();

  const years: YearSnapshot[] = [];
  const ledger: LedgerEvent[] = [];
  const warnings: ProjectionWarning[] = [];
  const warnedThisYear = new Set<string>(); // `${year}:${accountId}`
  // Display names for the per-item cash-flow breakdown, keyed by Posting.sourceId
  // (and mortgage account id). Stable across the whole run.
  const itemLabels = new Map<Id, string>();
  // Whether each contribution line is payroll-deducted (excluded from cash
  // flow) vs funded from take-home, keyed by sourceId.
  const contributionFromPaycheck = new Map<Id, boolean>();

  let currentYear = yearOf(settings.startDate);
  let acc = freshAccumulator(accountIds);
  const yearStartBalances = new Map<Id, number>(balances);

  // Single source of truth for withdrawal tax. Any time `amount` leaves a
  // taxable / tax-deferred account -- a transfer or sale out of it, an RMD, a
  // draw to cover spending, a cap-overflow rebalance -- that sale realizes
  // tax = amount * rate, deducted from the same account and tallied on the
  // "Taxes on withdrawals & RMDs" cash-flow line. Cash and Roth carry a 0 rate.
  // Deposits and moving *cash* into investments are never taxed.
  const realizeWithdrawalTax = (sourceId: Id, amount: number): number => {
    if (amount <= 0) return 0;
    const src = accountById.get(sourceId);
    const rate = src ? withdrawalTaxRate(src, taxRates) : 0;
    if (rate <= 0) return 0;
    const tax = amount * rate;
    balances.set(sourceId, (balances.get(sourceId) ?? 0) - tax);
    const bucket = acc.rollforward.get(sourceId);
    if (bucket) bucket.withdrawals += tax;
    acc.taxesPaid += tax;
    return tax;
  };

  const months = [...eachMonthStart(settings.startDate, settings.horizonEndDate)];

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const yearMonth = month.slice(0, 7);
    const isJanuary = month.endsWith("-01-01");

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
      } else if (posting.category === "expense") {
        acc.totalExpenses += -posting.amount;
        addTo(acc.expenseByItem, posting.sourceId, -posting.amount);
        itemLabels.set(posting.sourceId, posting.label);
      } else if (posting.category === "contribution_in") {
        addTo(acc.contributionsByItem, posting.sourceId, posting.amount);
        itemLabels.set(posting.sourceId, posting.label);
        const fromPaycheck = accountById.get(posting.accountId)?.contribution?.payrollDeducted ?? false;
        contributionFromPaycheck.set(posting.sourceId, fromPaycheck);
        // Take-home-funded contributions cost cash; the matching contribution_out
        // posting handles the spending-account balance, so we only tally the
        // total here (avoids double counting). Payroll-deducted ones cost nothing.
        if (!fromPaycheck) acc.afterTaxContributions += posting.amount;
      }
      // contribution_out / transfer: balance + rollforward already handled above.

      // Any outflow from a taxable / tax-deferred account (a transfer out, or an
      // expense paid straight from it) is a sale that realizes tax.
      if (posting.amount < 0) realizeWithdrawalTax(posting.accountId, -posting.amount);
    }

    // 3. Amortize mortgages/loans.
    for (const account of accounts) {
      if (account.isExcluded) continue;
      if (account.class !== "mortgage" && account.class !== "loan") continue;
      if (compareDates(month, account.effectiveStartDate) < 0) continue;
      if (month.slice(0, 7) === account.effectiveStartDate.slice(0, 7)) continue; // originates this month, first payment next month
      const mortgage = mortgageByAccountId.get(account.id);
      const payment = mortgagePayments.get(account.id);
      if (!mortgage || !payment) continue;
      const step = amortizeMonth(balances.get(account.id) ?? 0, mortgage.loanTerms.annualInterestRatePct, payment);
      balances.set(account.id, step.newBalance);
      acc.rollforward.get(account.id)!.withdrawals += step.principalPortion;

      const payerId = mortgage.payingAccountId;
      if (payerId) {
        balances.set(payerId, (balances.get(payerId) ?? 0) - payment);
        const payerBucket = acc.rollforward.get(payerId);
        if (payerBucket) payerBucket.withdrawals += payment;
        acc.totalExpenses += payment;
        addTo(acc.expenseByItem, account.id, payment);
        itemLabels.set(account.id, `Mortgage payment (${account.name})`);
        ledger.push({
          date: month,
          kind: "mortgage_payment",
          accountId: payerId,
          toAccountId: account.id,
          amount: payment,
          note: `Mortgage payment (${account.name})`,
        });
      }
    }

    // 4. RMDs -- once per year, in January, using the prior Dec-31 balance.
    if (isJanuary) {
      const year = yearOf(month);
      for (const account of accounts) {
        if (account.isExcluded || !account.subjectToRMD || !account.ownerId) continue;
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
        addTo(acc.rmdByAccount, account.id, rmdAmount);
        if (primarySpendingAccountId && primarySpendingAccountId !== account.id) {
          balances.set(primarySpendingAccountId, (balances.get(primarySpendingAccountId) ?? 0) + rmdAmount);
          acc.rollforward.get(primarySpendingAccountId)!.deposits += rmdAmount;
        }
        // Tax on the forced distribution, realized at the source like any other
        // withdrawal from the account.
        realizeWithdrawalTax(account.id, rmdAmount);
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

    // 5. Surplus routing. Each hub keeps a buffer before sweeping; each fill
    //    stop has an optional maxBalance ceiling (grown yearly for inflation);
    //    a stop is filled only up to its ceiling and the overflow spills to
    //    the next stop in list order. Uncapped stops absorb everything
    //    (Infinity room), matching the legacy behavior.
    const yearsSinceStart = currentYear - yearOf(settings.startDate);
    const inflationFactor = Math.pow(1 + settings.inflationRatePct, Math.max(0, yearsSinceStart));
    for (const { account: spender, hub } of spendingHubs) {
      const balance = balances.get(spender.id) ?? 0;
      // Keep a cash buffer in the spending account (grown for inflation) and
      // only sweep what's above it -- prevents zeroing out checking each month
      // and the resulting sweep/withdraw churn.
      const buffer = (hub.bufferAmount ?? 0) * inflationFactor;
      let remaining = balance - buffer;
      if (remaining <= 0) continue;
      // Fixed-split percentages apply to the whole sweepable surplus, not the
      // running remainder, so each target's share is independent of order.
      const splitBase = remaining;
      for (const { account: target, stop } of fillStops) {
        if (remaining <= 0) break;
        if (target.id === spender.id) continue;
        const cap = effectiveMaxBalance(stop, yearsSinceStart, settings.inflationRatePct);
        const room = cap - (balances.get(target.id) ?? 0);
        if (room <= 0) continue; // target already at/over its ceiling -- spill onward
        const requested =
          moneyFlow.splitMode === "fixed_split" ? splitBase * (stop.splitPct ?? 0) : remaining; // priority_fill: this target takes all it can hold
        const take = Math.min(requested, room, remaining);
        if (take <= 0) continue;
        balances.set(spender.id, (balances.get(spender.id) ?? 0) - take);
        balances.set(target.id, (balances.get(target.id) ?? 0) + take);
        acc.rollforward.get(spender.id)!.withdrawals += take;
        acc.rollforward.get(target.id)!.deposits += take;
        acc.surplusRouted += take;
        addTo(acc.surplusByAccount, target.id, take);
        remaining -= take;
      }
    }

    // 5b. Cap overflow. The sweep above only catches money entering a target
    //     from a spending account. A target can also exceed its cap via a
    //     custom transfer landing on it directly, income deposited straight
    //     into it, or its own organic growth. So: for every fill stop
    //     currently above its cap, walk later stops in list order and push
    //     the excess down the chain, landing wherever there's room. This is a
    //     rebalance between the user's own accounts, so it's recorded in
    //     rollforwards (balances must still reconcile) but explicitly NOT
    //     counted in the surplusRouted headline, which tracks routed income only.
    for (let ti = 0; ti < fillStops.length; ti++) {
      const over = fillStops[ti];
      const overCap = effectiveMaxBalance(over.stop, yearsSinceStart, settings.inflationRatePct);
      let excess = (balances.get(over.account.id) ?? 0) - overCap;
      if (excess <= 0.005) continue;
      for (let tj = ti + 1; tj < fillStops.length && excess > 0.005; tj++) {
        const dest = fillStops[tj];
        const destCap = effectiveMaxBalance(dest.stop, yearsSinceStart, settings.inflationRatePct);
        const room = destCap - (balances.get(dest.account.id) ?? 0);
        if (room <= 0) continue; // next target also full -- keep spilling onward
        const move = Math.min(excess, room);
        balances.set(over.account.id, (balances.get(over.account.id) ?? 0) - move);
        balances.set(dest.account.id, (balances.get(dest.account.id) ?? 0) + move);
        acc.rollforward.get(over.account.id)!.withdrawals += move;
        acc.rollforward.get(dest.account.id)!.deposits += move;
        // Overflowing out of a taxable account is still a sale -- tax it.
        realizeWithdrawalTax(over.account.id, move);
        excess -= move;
      }
      // Any excess still left here had nowhere to go (every downstream target is
      // full and there is no uncapped catch-all); it stays put -- we can't force
      // money out with no destination.
    }

    // 6. Deficit cascade.
    for (const { account: spender } of spendingHubs) {
      let shortfall = -(balances.get(spender.id) ?? 0);
      if (shortfall <= 0) continue;
      for (const source of cascadeSources) {
        if (shortfall <= 0) break;
        if (source.id === spender.id) continue;
        const available = balances.get(source.id) ?? 0;
        if (available <= 0) continue;
        // Pulling `provide` to cover spending also realizes `provide * rate` in
        // tax, both out of this account, so the two together can't exceed what's
        // there: provide <= available / (1 + rate).
        const rate = withdrawalTaxRate(source, taxRates);
        const provide = Math.min(shortfall, available / (1 + rate));
        if (provide <= 0) continue;
        balances.set(source.id, (balances.get(source.id) ?? 0) - provide);
        balances.set(spender.id, (balances.get(spender.id) ?? 0) + provide);
        acc.rollforward.get(source.id)!.withdrawals += provide;
        acc.rollforward.get(spender.id)!.deposits += provide;
        acc.deficitCovered += provide;
        addTo(acc.withdrawalsByAccount, source.id, provide);
        const tax = realizeWithdrawalTax(source.id, provide);
        shortfall -= provide;
        ledger.push({
          date: month,
          kind: "deficit_withdrawal",
          accountId: source.id,
          toAccountId: spender.id,
          amount: provide,
          note:
            tax > 0.005
              ? `Covering shortfall in ${spender.name} (+ ${Math.round(tax)} tax)`
              : `Covering shortfall in ${spender.name}`,
        });
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

      const endingCashBalance = activeAccounts
        .filter((a) => a.class === "cash")
        .reduce((s, a) => s + (balances.get(a.id) ?? 0), 0);

      // Sorted line-item arrays; labels come from itemLabels (posting/mortgage
      // ids) or the account name (for account-keyed maps).
      const toLineItems = (map: Map<Id, number>) =>
        [...map.entries()]
          .map(([id, amount]) => ({ id, label: itemLabels.get(id) ?? id, amount }))
          .sort((a, b) => b.amount - a.amount);
      const toAccountItems = (map: Map<Id, number>) =>
        [...map.entries()]
          .filter(([, amount]) => amount > 0.005)
          .map(([id, amount]) => ({ id, label: accountById.get(id)?.name ?? id, amount }))
          .sort((a, b) => b.amount - a.amount);

      const cashFlow: CashFlowYearRow = {
        year: currentYear,
        totalIncome: acc.totalIncome,
        totalExpenses: acc.totalExpenses,
        // Withdrawal/RMD taxes are a cash outflow -- shown on their own line but
        // still subtracted here so they count against the bottom line.
        netCashFlow: acc.totalIncome - acc.totalExpenses - acc.afterTaxContributions - acc.taxesPaid,
        surplusRouted: acc.surplusRouted,
        deficitCovered: acc.deficitCovered,
        rmdTotal: acc.rmdTotal,
        withdrawalTaxes: acc.taxesPaid,
        endingCashBalance,
        afterTaxContributionTotal: acc.afterTaxContributions,
        incomeByItem: toLineItems(acc.incomeByItem),
        expenseByItem: toLineItems(acc.expenseByItem),
        contributionsByItem: [...acc.contributionsByItem.entries()]
          .map(([id, amount]) => ({
            id,
            label: itemLabels.get(id) ?? id,
            amount,
            fromPaycheck: contributionFromPaycheck.get(id) ?? false,
          }))
          .sort((a, b) => b.amount - a.amount),
        surplusByAccount: toAccountItems(acc.surplusByAccount),
        withdrawalsByAccount: toAccountItems(acc.withdrawalsByAccount),
        rmdByAccount: toAccountItems(acc.rmdByAccount),
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
