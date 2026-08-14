import type { ISODate, Id } from "@/domain";
import {
  closesLotOn,
  contractMultiplier,
  formatOptionSymbol,
  normalizeSymbol,
  opensLotOn,
  signedCashFlow,
  type AssetClass,
  type Portfolio,
  type PositionSide,
  type Security,
  type Transaction,
} from "@/domain/portfolio";
import { accountCashBalances } from "./cash";
import { buildLotLedger, type ClosedLot, type LedgerWarning, type OpenLot } from "./lots";
import { findExpiredContracts, type ExpiredContract } from "./expiredContracts";

export interface PriceQuote {
  price: number;
  /** Trading day the price is from — a stale quote should say so, not pretend. */
  date: ISODate;
  /** The feed's name for the security, used when nothing local names it. */
  name?: string;
}

export type PriceMap = Record<string, PriceQuote>;

/** The symbol a cash row carries. Leads with `$` so it can never collide with
 *  a real ticker, and so the quote feed is never asked to price it. */
export const CASH_SYMBOL = "$CASH";

export interface Holding {
  key: string;
  accountId: Id;
  /**
   * What this row is. Uninvested cash sits alongside positions so allocation
   * reflects what you actually own, but it has no basis, no quote, and no
   * return -- every figure that assumes a security has to skip it.
   */
  kind: "position" | "cash";
  symbol: string;
  name: string;
  assetClass: AssetClass;
  side: PositionSide;
  /** Shares owned (long) or owed (short). Always positive; read `side` for direction. */
  quantity: number;
  /** Cost paid to open, for a long. Proceeds received, for a short. */
  costBasis: number;
  avgCostPerShare: number;
  price: number | null;
  priceDate: ISODate | null;
  marketValue: number;
  unrealizedGain: number;
  /** Null when there is no basis to measure against (fully gifted shares). */
  unrealizedGainPct: number | null;
  /** Share of the total market value in scope, 0–1. */
  weight: number;
  realizedGain: number;
  income: number;
  totalGain: number;
  /** Annualized money-weighted return, null when it can't be solved. */
  irr: number | null;
  lots: OpenLot[];
}

export interface PortfolioSummary {
  /** Positions only. Cash is reported separately so the return figures below,
   *  which are all position figures, keep a denominator that matches them. */
  marketValue: number;
  cash: number;
  totalValue: number;
  costBasis: number;
  unrealizedGain: number;
  unrealizedGainPct: number | null;
  realizedGain: number;
  realizedShortTerm: number;
  realizedLongTerm: number;
  realizedGainYtd: number;
  income: number;
  totalGain: number;
  irr: number | null;
}

export interface AllocationSlice {
  label: string;
  value: number;
  weight: number;
}

/**
 * Rolls holdings up into allocation slices along whatever dimension `pick`
 * names, ordered largest first.
 *
 * Dropping cash renormalizes against what's left rather than leaving a gap:
 * with cash excluded the question has changed to "of the money I have
 * invested, how much is in this", and slices that summed to 90% would be
 * answering neither question.
 */
export function buildAllocation(
  holdings: readonly Holding[],
  pick: (holding: Holding) => string,
  options: { includeCash?: boolean } = {},
): AllocationSlice[] {
  const rows = options.includeCash === false ? holdings.filter((h) => h.kind !== "cash") : holdings;
  const total = rows.reduce((sum, h) => sum + h.marketValue, 0);

  const grouped = new Map<string, number>();
  for (const holding of rows) {
    const label = pick(holding);
    grouped.set(label, (grouped.get(label) ?? 0) + holding.marketValue);
  }

  return [...grouped.entries()]
    .map(([label, value]) => ({ label, value, weight: total > 0 ? value / total : 0 }))
    .sort((a, b) => b.value - a.value);
}

const DAYS_PER_YEAR = 365;

function daysBetween(from: ISODate, to: ISODate): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return (b - a) / 86_400_000;
}

function npv(flows: readonly { date: ISODate; amount: number }[], rate: number, start: ISODate) {
  return flows.reduce((sum, flow) => {
    const years = daysBetween(start, flow.date) / DAYS_PER_YEAR;
    return sum + flow.amount / Math.pow(1 + rate, years);
  }, 0);
}

/**
 * Money-weighted (dollar-weighted) annualized return — the rate that discounts
 * every cash flow back to zero. Bisection rather than Newton's method: it is
 * slower but cannot diverge, and a return figure that silently comes back as
 * NaN on an awkward flow pattern is worse than a slightly slower one.
 *
 * Returns null unless the flows change sign, since a series that only ever
 * paid out (or only ever paid in) has no rate of return to find.
 */
export function xirr(flows: readonly { date: ISODate; amount: number }[]): number | null {
  const meaningful = flows.filter((f) => f.amount !== 0);
  if (meaningful.length < 2) return null;
  if (!meaningful.some((f) => f.amount > 0) || !meaningful.some((f) => f.amount < 0)) return null;

  const sorted = [...meaningful].sort((a, b) => (a.date < b.date ? -1 : 1));
  const start = sorted[0].date;

  let low = -0.9999;
  let high = 10;
  let lowValue = npv(sorted, low, start);
  if (lowValue * npv(sorted, high, start) > 0) return null;

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const midValue = npv(sorted, mid, start);
    if (Math.abs(midValue) < 1e-7) return mid;
    if (lowValue * midValue < 0) {
      high = mid;
    } else {
      low = mid;
      lowValue = midValue;
    }
  }
  return (low + high) / 2;
}

function priceFor(symbol: string, prices: PriceMap, security: Security | undefined): PriceQuote | null {
  if (security?.manualPrice != null) {
    return { price: security.manualPrice, date: security.manualPriceDate ?? "" };
  }
  return prices[symbol] ?? null;
}

/**
 * Cash flows for an internal rate of return, built from the trades themselves
 * rather than from account deposits. Statements reliably export trades but
 * often not transfers, so anchoring on trades is what makes a return figure
 * computable from a typical import. Buys count as money in, sells and
 * dividends as money out, and whatever is still held is treated as a final
 * payout on the valuation date.
 */
function returnFlows(
  transactions: readonly Transaction[],
  terminalValue: number,
  asOf: ISODate,
): { date: ISODate; amount: number }[] {
  const flows = transactions
    .map((tx) => ({ date: tx.date, amount: signedCashFlow(tx) }))
    .filter((flow) => flow.amount !== 0);
  if (terminalValue > 0) flows.push({ date: asOf, amount: terminalValue });
  return flows;
}

/**
 * An internal rate of return needs capital committed up front to be a return
 * *on* anything, and a short commits none -- it takes cash in at the open and
 * pays it out at the close. Run on the raw flows it yields a borrowing rate,
 * where a profitable short reports as a large negative number; flipping the
 * signs is no better, since it then reports the proceeds as if they were an
 * investment and calls a winning position a loss.
 *
 * So shorts get no annualized figure at all. The unrealized return percentage,
 * measured against the proceeds, is the honest way to read a short's
 * performance, and printing a confidently wrong number beside it would be worse
 * than printing none.
 */
function annualizedReturn(
  side: PositionSide,
  transactions: readonly Transaction[],
  terminalValue: number,
  asOf: ISODate,
): number | null {
  if (side === "short") return null;
  return xirr(returnFlows(transactions, terminalValue, asOf));
}

function todayIso(): ISODate {
  return new Date().toISOString().slice(0, 10);
}

export interface PortfolioAnalysis {
  holdings: Holding[];
  summary: PortfolioSummary;
  closedLots: ClosedLot[];
  warnings: LedgerWarning[];
  /** Contracts still open past their expiry, awaiting the event that closed them. */
  expiredContracts: ExpiredContract[];
  byAssetClass: AllocationSlice[];
  byAccount: AllocationSlice[];
  bySymbol: AllocationSlice[];
}

/**
 * Replays the whole ledger into holdings, allocations, and performance.
 * Everything here is derived — nothing is read back from stored totals — so
 * editing a single transaction always reconciles the entire tracker.
 *
 * `accountIds` narrows the scope; omit it for the whole portfolio. Weights are
 * always relative to the scope in view, so a filtered account's positions still
 * add to 100%.
 */
export function analyzePortfolio(
  portfolio: Portfolio,
  prices: PriceMap,
  options: { accountIds?: readonly Id[]; asOf?: ISODate } = {},
): PortfolioAnalysis {
  const asOf = options.asOf ?? todayIso();
  const scope = options.accountIds;
  const inScope = (accountId: Id) => !scope || scope.includes(accountId);

  const transactions = portfolio.transactions.filter((tx) => inScope(tx.accountId));
  const { openLots, closedLots, warnings } = buildLotLedger(transactions);

  const securities = new Map(portfolio.securities.map((s) => [normalizeSymbol(s.symbol), s]));
  const accountNames = new Map(portfolio.accounts.map((a) => [a.id, a.name]));

  const lotsByPosition = new Map<string, OpenLot[]>();
  for (const lot of openLots) {
    const key = `${lot.accountId}::${lot.symbol}::${lot.side}`;
    const bucket = lotsByPosition.get(key);
    if (bucket) bucket.push(lot);
    else lotsByPosition.set(key, [lot]);
  }

  const holdings: Holding[] = [];
  for (const [key, lots] of lotsByPosition) {
    const { accountId, symbol, side } = lots[0];
    const security = securities.get(symbol);
    const quote = priceFor(symbol, prices, security);
    const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
    const costBasis = lots.reduce((sum, lot) => sum + lot.costBasis, 0);

    // An option contract controls 100 shares, so its quoted per-share premium
    // buys 100x what the number reads as. Ordinary shares multiply by 1.
    const multiplier = contractMultiplier(symbol);

    // A short is a liability: its market value is what covering would cost, so
    // it carries into every total as a negative, and it gains when the price
    // falls below the proceeds it opened at.
    const exposure = quote ? quantity * quote.price * multiplier : costBasis;
    const marketValue = side === "short" ? -exposure : exposure;
    const unrealizedGain = !quote ? 0 : side === "short" ? costBasis - exposure : exposure - costBasis;

    // Only the transactions on this side belong to this position -- otherwise a
    // symbol held both long and short would double-count its own history.
    const positionTxs = transactions.filter(
      (tx) =>
        tx.accountId === accountId &&
        tx.symbol !== null &&
        normalizeSymbol(tx.symbol) === symbol &&
        (opensLotOn(tx.type) === side || closesLotOn(tx.type) === side),
    );
    const realizedGain = closedLots
      .filter(
        (lot) => lot.taxable && lot.accountId === accountId && lot.symbol === symbol && lot.side === side,
      )
      .reduce((sum, lot) => sum + lot.gain, 0);
    // Dividends follow the shares, so they land on the long side. A short pays
    // them out instead, which shows up as its own transaction.
    const income = transactions
      .filter(
        (tx) =>
          tx.accountId === accountId &&
          tx.symbol !== null &&
          normalizeSymbol(tx.symbol) === symbol &&
          side === "long" &&
          (tx.type === "dividend" || tx.type === "interest"),
      )
      .reduce((sum, tx) => sum + signedCashFlow(tx), 0);

    holdings.push({
      key,
      accountId,
      kind: "position",
      symbol,
      name: security?.name || prices[symbol]?.name || formatOptionSymbol(symbol),
      assetClass: security?.assetClass ?? "other",
      side,
      quantity,
      costBasis,
      // Divided by the multiplier so it stays comparable to `price`: both are
      // then per-share premiums, which is the comparison the column exists for.
      avgCostPerShare: quantity > 0 ? costBasis / (quantity * multiplier) : 0,
      price: quote?.price ?? null,
      priceDate: quote?.date || null,
      marketValue,
      unrealizedGain,
      unrealizedGainPct: costBasis > 0 ? unrealizedGain / costBasis : null,
      weight: 0,
      realizedGain,
      income,
      totalGain: unrealizedGain + realizedGain + income,
      irr: annualizedReturn(side, positionTxs, marketValue, asOf),
      lots: [...lots].sort((a, b) => (a.acquiredDate < b.acquiredDate ? -1 : 1)),
    });
  }

  const marketValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);

  // Summary figures are computed before the cash rows join, so every one of
  // them keeps meaning what it meant: a return measured against the money
  // actually at risk, not diluted by a balance that was never invested.
  const costBasis = holdings.reduce((sum, h) => sum + h.costBasis, 0);
  const unrealizedGain = holdings.reduce((sum, h) => sum + h.unrealizedGain, 0);
  const income = holdings.reduce((sum, h) => sum + h.income, 0);

  // Replayed from the ledger, not read off the account: cash is derived here for
  // the same reason every other total is, so importing a row moves it.
  const cashByAccount = accountCashBalances(portfolio, { asOf });
  const cashAccounts = portfolio.accounts.filter((a) => inScope(a.id));
  const cashOf = (accountId: Id) => cashByAccount.get(accountId)?.balance ?? 0;
  const cash = cashAccounts.reduce((sum, a) => sum + cashOf(a.id), 0);

  /**
   * Uninvested cash, as a holding per account.
   *
   * It carries no basis and no gain -- cash doesn't appreciate, and giving it a
   * basis equal to its balance would quietly pad the denominator under every
   * return figure. Only value and weight are real here, which is exactly what
   * an allocation view is asking for.
   */
  for (const account of cashAccounts) {
    const balance = cashOf(account.id);
    if (balance === 0) continue;
    holdings.push({
      key: `${account.id}::${CASH_SYMBOL}`,
      accountId: account.id,
      kind: "cash",
      symbol: CASH_SYMBOL,
      name: "Cash",
      assetClass: "cash",
      side: "long",
      quantity: 0,
      costBasis: 0,
      avgCostPerShare: 0,
      price: null,
      priceDate: null,
      marketValue: balance,
      unrealizedGain: 0,
      unrealizedGainPct: null,
      weight: 0,
      realizedGain: 0,
      income: 0,
      totalGain: 0,
      irr: null,
      lots: [],
    });
  }

  // Weighted against everything owned, cash included, so the allocation adds up
  // to the whole portfolio rather than to the invested slice of it.
  const totalValue = marketValue + cash;
  for (const holding of holdings) {
    holding.weight = totalValue > 0 ? holding.marketValue / totalValue : 0;
  }
  holdings.sort((a, b) => b.marketValue - a.marketValue);

  const taxableClosed = closedLots.filter((lot) => lot.taxable);
  const realizedGain = taxableClosed.reduce((sum, lot) => sum + lot.gain, 0);
  const currentYear = asOf.slice(0, 4);

  const summary: PortfolioSummary = {
    marketValue,
    cash,
    totalValue: marketValue + cash,
    costBasis,
    unrealizedGain,
    unrealizedGainPct: costBasis > 0 ? unrealizedGain / costBasis : null,
    realizedGain,
    realizedShortTerm: taxableClosed
      .filter((lot) => lot.term === "short")
      .reduce((sum, lot) => sum + lot.gain, 0),
    realizedLongTerm: taxableClosed
      .filter((lot) => lot.term === "long")
      .reduce((sum, lot) => sum + lot.gain, 0),
    realizedGainYtd: taxableClosed
      .filter((lot) => lot.disposedDate.startsWith(currentYear))
      .reduce((sum, lot) => sum + lot.gain, 0),
    income,
    totalGain: unrealizedGain + realizedGain + income,
    irr: xirr(returnFlows(transactions, marketValue + cash, asOf)),
  };

  return {
    holdings,
    summary,
    closedLots: [...closedLots].sort((a, b) => (a.disposedDate < b.disposedDate ? 1 : -1)),
    warnings,
    // Only positions can have expired -- a cash row has no contract behind it.
    expiredContracts: findExpiredContracts(
      holdings.filter((h) => h.kind === "position"),
      prices,
      asOf,
    ),
    byAssetClass: buildAllocation(holdings, (h) => h.assetClass),
    byAccount: buildAllocation(holdings, (h) => accountNames.get(h.accountId) ?? "Unknown account"),
    bySymbol: buildAllocation(holdings, (h) => h.symbol),
  };
}
