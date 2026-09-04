import type { ISODate, Id } from "@/domain";
import {
  closesLotOn,
  contractMultiplier,
  formatOptionSymbol,
  isOptionSymbol,
  normalizeSymbol,
  opensLotOn,
  resolveExposures,
  signedCashFlow,
  type AssetClass,
  type Exposure,
  type InstrumentType,
  type Portfolio,
  type PositionSide,
  type Security,
  type Transaction,
  type TransactionType,
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
  /**
   * The prior session's close. Null, or absent, when nothing supplied one --
   * a hand-entered manual price has no yesterday, and the feed occasionally
   * omits it. Every day-move figure is skipped rather than guessed in that case.
   */
  previousClose?: number | null;
}

export type PriceMap = Record<string, PriceQuote>;

/** The symbol a cash row carries. Leads with `$` so it can never collide with
 *  a real ticker, and so the quote feed is never asked to price it. */
export const CASH_SYMBOL = "$CASH";

/**
 * A symbol's class split, instrument type, and theme tags, read off its
 * security record. The one place this is worked out, so a holding and a
 * historical performance series -- which has no holding to build, only a
 * symbol out of the transaction ledger -- classify a symbol identically.
 */
export function classifySymbol(
  symbol: string,
  security: Security | undefined,
): { assetClass: AssetClass; exposures: Exposure[]; instrumentType: InstrumentType; themes: string[] } {
  return {
    assetClass: security?.assetClass ?? "other",
    exposures: resolveExposures({
      assetClass: security?.assetClass ?? "other",
      exposures: security?.exposures ?? [],
    }),
    // Syntactic, not read off the security record: an option contract is
    // recognisable from its symbol alone, so it reads as an option even
    // before the feed has ever classified it.
    instrumentType: isOptionSymbol(symbol) ? "option" : (security?.instrumentType ?? "other"),
    themes: security?.themes ?? [],
  };
}

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
  /** The primary class -- what filters, sorting, and every dimension besides
   *  "by class" itself treat this holding as. */
  assetClass: AssetClass;
  /** How the position's value actually splits across classes, renormalized to
   *  sum to 1. A single-class holding (almost everything) carries one entry
   *  identical to `assetClass`; a fund like VT carries one row per class it
   *  spans. See `explodeExposures` for turning this into groupable rows. */
  exposures: Exposure[];
  instrumentType: InstrumentType;
  /** Free-form tags, e.g. "AI", "Dividend growth". A holding can carry several
   *  or none; grouping and filtering by theme treat these as independent, not
   *  as a split of the holding's value the way `exposures` is. */
  themes: string[];
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
  /**
   * What this position has made or lost since the prior close, in dollars.
   *
   * Null when the quote carried no previous close, which is different from
   * zero: an unmoved position and an unmeasurable one must not read the same.
   */
  dayChange: number | null;
  /** The same move as a fraction of yesterday's value. */
  dayChangePct: number | null;
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
  /**
   * Dividends and interest received over the portfolio's whole life.
   *
   * Read straight off the ledger rather than summed from holdings, so a
   * dividend from a position that has since been sold still counts -- the
   * money was received either way, and a position closed out entirely
   * shouldn't erase what it paid out along the way.
   */
  income: number;
  /** Same, but since January 1st. */
  incomeYtd: number;
  totalGain: number;
  /**
   * What the positions in scope moved today, in dollars, and as a fraction of
   * what they closed at yesterday. Null when no priced holding carried a
   * previous close, so there is nothing to measure the day against.
   */
  dayChange: number | null;
  dayChangePct: number | null;
  irr: number | null;
}

export interface AllocationSlice {
  label: string;
  value: number;
  weight: number;
  /**
   * What a basket slice is made of, largest first, each carrying its own share
   * of the same portfolio total -- so the members sum to exactly the basket's
   * own value and weight. Absent on every ordinary slice, which is how a
   * caller tells the two apart.
   */
  members?: AllocationSlice[];
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

/**
 * Allocation by theme tag.
 *
 * Every other dimension partitions the portfolio: each holding lands in
 * exactly one bucket, and the buckets sum to the total. Themes don't --
 * VT could be tagged both "Core" and "Dividend growth", and a holding with no
 * tags at all still needs somewhere to go. So these slices are allowed to
 * overlap, `weight` still means "share of the portfolio", and the slices as a
 * whole are not expected to sum to 1.
 */
export function buildThemeAllocation(
  holdings: readonly Holding[],
  options: { includeCash?: boolean } = {},
): AllocationSlice[] {
  const rows = options.includeCash === false ? holdings.filter((h) => h.kind !== "cash") : holdings;
  const total = rows.reduce((sum, h) => sum + h.marketValue, 0);

  const grouped = new Map<string, number>();
  for (const holding of rows) {
    const tags = holding.themes.length > 0 ? holding.themes : ["Untagged"];
    for (const tag of tags) {
      grouped.set(tag, (grouped.get(tag) ?? 0) + holding.marketValue);
    }
  }

  return [...grouped.entries()]
    .map(([label, value]) => ({ label, value, weight: total > 0 ? value / total : 0 }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Allocation by holding, with baskets standing in for their members.
 *
 * A basket is a group the owner treats as one position, so it takes one slice
 * carrying the summed value of everything inside it, and the members it
 * replaced ride along under `members` for a view that wants to open it up.
 * Membership partitions -- a symbol is in at most one basket -- so swapping a
 * basket in for its members leaves the total, and every other slice's weight,
 * exactly where it was.
 *
 * Cash never joins a basket: it is one row per account with no security behind
 * it, and grouping it with positions would put money that isn't invested
 * inside something being read as an investment.
 */
export function buildBasketAllocation(
  holdings: readonly Holding[],
  basketFor: (symbol: string) => { id: string; name: string } | null,
  options: { includeCash?: boolean } = {},
): AllocationSlice[] {
  const rows = options.includeCash === false ? holdings.filter((h) => h.kind !== "cash") : holdings;
  const total = rows.reduce((sum, h) => sum + h.marketValue, 0);
  const share = (value: number) => (total > 0 ? value / total : 0);

  // Keyed by basket id or by symbol, never by the label -- a basket named
  // after a ticker it doesn't contain would otherwise quietly swallow it.
  const grouped = new Map<string, { label: string; value: number; members: Map<string, number> | null }>();
  for (const holding of rows) {
    const symbol = holding.kind === "cash" ? "Cash" : holding.symbol;
    const basket = holding.kind === "cash" ? null : basketFor(symbol);
    const key = basket ? `basket:${basket.id}` : `symbol:${symbol}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { label: basket ? basket.name : symbol, value: 0, members: basket ? new Map() : null };
      grouped.set(key, entry);
    }
    entry.value += holding.marketValue;
    // One symbol can hold in several accounts; the basket's breakdown is by
    // name, matching what the ungrouped view would have shown.
    if (entry.members) entry.members.set(symbol, (entry.members.get(symbol) ?? 0) + holding.marketValue);
  }

  return [...grouped.values()]
    .map((entry) => ({
      label: entry.label,
      value: entry.value,
      weight: share(entry.value),
      ...(entry.members
        ? {
            members: [...entry.members.entries()]
              .map(([label, value]) => ({ label, value, weight: share(value) }))
              .sort((a, b) => b.value - a.value),
          }
        : {}),
    }))
    .sort((a, b) => b.value - a.value);
}

export interface ExposureRow extends Holding {
  /** The class this row stands for, which may differ from the underlying
   *  holding's own `assetClass` -- its primary class -- once split. */
  exposureClass: AssetClass;
  /** Share of the holding's own value this row carries, 0-1. 1 for a
   *  single-class holding, since it isn't actually split. */
  exposureWeight: number;
  /** How many rows this holding exploded into. 1 means this row *is* the
   *  holding; more means it's a partial slice of one. */
  exposureCount: number;
  /** The real, whole holding this row is a slice of -- what to open, select,
   *  or match transactions against, since the row itself is a fraction that
   *  exists only for this breakdown. */
  source: Holding;
}

/**
 * Explodes each holding into one row per asset class its value actually
 * touches, so a table grouped by class can show VT once under US Equity at
 * 60% of its value and once under International at the other 40%, rather than
 * forcing the whole position into a single bucket.
 *
 * `marketValue`, `costBasis`, `unrealizedGain`, and `weight` scale down by
 * each row's share, so the exploded rows still sum to the original holding's
 * totals. Per-share figures (`price`, `avgCostPerShare`) and ratios
 * (`unrealizedGainPct`, `irr`) pass through unchanged -- they describe the
 * position as a whole, and splitting them would misstate both halves.
 */
export function explodeExposures(holdings: readonly Holding[]): ExposureRow[] {
  const rows: ExposureRow[] = [];
  for (const holding of holdings) {
    const exposures = holding.exposures.length > 0 ? holding.exposures : [{ assetClass: holding.assetClass, weight: 1 }];
    for (const exposure of exposures) {
      rows.push({
        ...holding,
        key: exposures.length > 1 ? `${holding.key}::${exposure.assetClass}` : holding.key,
        assetClass: exposure.assetClass,
        exposureClass: exposure.assetClass,
        exposureWeight: exposure.weight,
        exposureCount: exposures.length,
        marketValue: holding.marketValue * exposure.weight,
        costBasis: holding.costBasis * exposure.weight,
        unrealizedGain: holding.unrealizedGain * exposure.weight,
        weight: holding.weight * exposure.weight,
        source: holding,
      });
    }
  }
  return rows;
}

const DAYS_PER_YEAR = 365;

/**
 * Days since the epoch for an ISO date, without constructing a `Date`.
 *
 * This is the hot path of every return figure in the app: the bisection below
 * evaluates its whole flow series up to 200 times, so a `new Date(string)` per
 * flow per iteration meant millions of string parses to answer one number --
 * on a large ledger it was seconds of blocked main thread, and it dominated
 * every render of the holdings table.
 *
 * Reading the three fields directly and going through `Date.UTC` also drops
 * the DST artifact the old local-midnight parse carried, where a window
 * spanning a clock change measured as 0.958 or 1.042 days instead of 1.
 */
function daysFromEpoch(date: ISODate): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/**
 * Flows folded onto one entry per date, measured in years from the first.
 *
 * Discounting depends only on *when* a flow lands, so flows sharing a date
 * discount by the same factor and can be summed before the bisection rather
 * than during each of its iterations. That is exact arithmetic, not an
 * approximation -- and on a ledger that buys fifteen funds every payday it
 * collapses the series an order of magnitude before any work is done on it.
 */
function discountablePoints(
  flows: readonly { date: ISODate; amount: number }[],
): { years: Float64Array; amounts: Float64Array } {
  const byDate = new Map<number, number>();
  for (const flow of flows) {
    if (flow.amount === 0) continue;
    const day = daysFromEpoch(flow.date);
    byDate.set(day, (byDate.get(day) ?? 0) + flow.amount);
  }

  const days = [...byDate.keys()].sort((a, b) => a - b);
  const start = days[0] ?? 0;
  const years = new Float64Array(days.length);
  const amounts = new Float64Array(days.length);
  for (let i = 0; i < days.length; i += 1) {
    years[i] = (days[i] - start) / DAYS_PER_YEAR;
    amounts[i] = byDate.get(days[i]) ?? 0;
  }
  return { years, amounts };
}

function npvAt(years: Float64Array, amounts: Float64Array, rate: number): number {
  const base = 1 + rate;
  let sum = 0;
  for (let i = 0; i < years.length; i += 1) {
    sum += amounts[i] / Math.pow(base, years[i]);
  }
  return sum;
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
  let positives = false;
  let negatives = false;
  let meaningful = 0;
  for (const flow of flows) {
    if (flow.amount === 0) continue;
    meaningful += 1;
    if (flow.amount > 0) positives = true;
    else negatives = true;
  }
  if (meaningful < 2 || !positives || !negatives) return null;

  const { years, amounts } = discountablePoints(flows);
  // Flows that cancelled exactly against same-day opposites leave nothing to
  // discount, and a single point can never cross zero.
  if (years.length < 2) return null;

  let low = -0.9999;
  let high = 10;
  let lowValue = npvAt(years, amounts, low);
  if (lowValue * npvAt(years, amounts, high) > 0) return null;

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const midValue = npvAt(years, amounts, mid);
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
 *
 * Funding rows are dropped rather than counted, which is the difference between
 * a return and a bank statement: a deposit is money crossing into the account,
 * not a payout the investments produced. Counted as flows they read as profit,
 * which on a well-funded ledger pushed the solved rate outside any believable
 * bracket and reported no figure at all.
 */
const FUNDING_TYPES = new Set<TransactionType>(["cash_deposit", "cash_withdrawal"]);

function returnFlows(
  transactions: readonly Transaction[],
  terminalValue: number,
  asOf: ISODate,
): { date: ISODate; amount: number }[] {
  const flows = transactions
    .filter((tx) => !FUNDING_TYPES.has(tx.type))
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
  // A Set rather than the caller's array: this is asked once per transaction,
  // so a linear scan of the scope turned every read of the ledger into a
  // product of the two.
  const scope = options.accountIds ? new Set(options.accountIds) : null;
  const inScope = (accountId: Id) => !scope || scope.has(accountId);

  // Passed straight through when nothing is filtered out, so the replay below
  // reuses the one the store and the quote prefetch already built rather than
  // repeating it against a copy that only differs by identity.
  const transactions = scope
    ? portfolio.transactions.filter((tx) => inScope(tx.accountId))
    : portfolio.transactions;
  const { openLots, closedLots, warnings } = buildLotLedger(transactions);

  const currentYearPrefix = asOf.slice(0, 4);

  /**
   * The ledger indexed the three ways the holdings loop below needs to read
   * it, in one pass.
   *
   * Each holding used to re-scan every transaction twice and every closed lot
   * once to find its own rows, which is a product of two things that both grow
   * with the ledger -- and each of those scans re-normalized the symbol of
   * every transaction it rejected. Building the buckets up front costs one
   * pass and turns each holding's lookup into a map hit.
   */
  const txsByPosition = new Map<string, Transaction[]>();
  const incomeByPosition = new Map<string, number>();
  let income = 0;
  let incomeYtd = 0;
  for (const tx of transactions) {
    const isIncome = tx.type === "dividend" || tx.type === "interest";
    if (isIncome) {
      // Read off the ledger directly, not summed from `holdings` -- a holding
      // exists only for a symbol still open, so a position closed out entirely
      // would drop every dividend it ever paid.
      const flow = signedCashFlow(tx);
      income += flow;
      if (tx.date.startsWith(currentYearPrefix)) incomeYtd += flow;
    }
    if (tx.symbol === null) continue;
    const key = `${tx.accountId}::${normalizeSymbol(tx.symbol)}`;
    const bucket = txsByPosition.get(key);
    if (bucket) bucket.push(tx);
    else txsByPosition.set(key, [tx]);
    if (isIncome) incomeByPosition.set(key, (incomeByPosition.get(key) ?? 0) + signedCashFlow(tx));
  }

  /** Taxable realized gain per account/symbol/side, indexed the same way. */
  const realizedByPosition = new Map<string, number>();
  for (const lot of closedLots) {
    if (!lot.taxable) continue;
    const key = `${lot.accountId}::${lot.symbol}::${lot.side}`;
    realizedByPosition.set(key, (realizedByPosition.get(key) ?? 0) + lot.gain);
  }

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

    // Yesterday's value of the same position, so the day move is a move in this
    // holding rather than in the price of one share of it. A short gains when
    // the price falls, so its move carries the opposite sign.
    const previousClose = quote?.previousClose ?? null;
    const previousValue = previousClose === null ? null : quantity * previousClose * multiplier;
    const dayChange =
      previousValue === null || !quote
        ? null
        : side === "short"
          ? previousValue - exposure
          : exposure - previousValue;
    const dayChangePct = dayChange === null || previousValue === null || previousValue === 0
      ? null
      : dayChange / previousValue;

    // Only the transactions on this side belong to this position -- otherwise a
    // symbol held both long and short would double-count its own history.
    const positionKeyBase = `${accountId}::${symbol}`;
    const positionTxs = (txsByPosition.get(positionKeyBase) ?? []).filter(
      (tx) => opensLotOn(tx.type) === side || closesLotOn(tx.type) === side,
    );
    const realizedGain = realizedByPosition.get(`${positionKeyBase}::${side}`) ?? 0;
    // Dividends follow the shares, so they land on the long side. A short pays
    // them out instead, which shows up as its own transaction.
    const positionIncome = side === "long" ? incomeByPosition.get(positionKeyBase) ?? 0 : 0;

    holdings.push({
      key,
      accountId,
      kind: "position",
      symbol,
      name: security?.name || prices[symbol]?.name || formatOptionSymbol(symbol),
      ...classifySymbol(symbol, security),
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
      dayChange,
      dayChangePct,
      weight: 0,
      realizedGain,
      income: positionIncome,
      totalGain: unrealizedGain + realizedGain + positionIncome,
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
      exposures: [{ assetClass: "cash", weight: 1 }],
      instrumentType: "cash",
      themes: [],
      side: "long",
      quantity: 0,
      costBasis: 0,
      avgCostPerShare: 0,
      price: null,
      priceDate: null,
      marketValue: balance,
      unrealizedGain: 0,
      unrealizedGainPct: null,
      dayChange: null,
      dayChangePct: null,
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

  /**
   * Today's move across the positions that could be measured.
   *
   * Summed over only the holdings the feed gave a previous close for, so a
   * portfolio where nothing could be measured reports null rather than a
   * confident $0.00. The percentage divides by what those same positions were
   * worth yesterday -- their value today less the move -- so it is a like-for-
   * like figure and not today's move over the whole portfolio including the
   * parts it says nothing about.
   */
  const dayMovers = holdings.filter((h) => h.dayChange !== null);
  const dayChange = dayMovers.length > 0 ? dayMovers.reduce((sum, h) => sum + (h.dayChange ?? 0), 0) : null;
  const dayBase = dayMovers.reduce((sum, h) => sum + h.marketValue, 0) - (dayChange ?? 0);
  const dayChangePct = dayChange !== null && dayBase !== 0 ? dayChange / dayBase : null;

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
      .filter((lot) => lot.disposedDate.startsWith(currentYearPrefix))
      .reduce((sum, lot) => sum + lot.gain, 0),
    income,
    incomeYtd,
    totalGain: unrealizedGain + realizedGain + income,
    dayChange,
    dayChangePct,
    // Positions only, to match the flows above: uninvested cash was never put
    // to work, and paying it out at the end would credit the investments with a
    // return on money that only ever sat there.
    irr: xirr(returnFlows(transactions, marketValue, asOf)),
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
    byAssetClass: buildAllocation(explodeExposures(holdings), (h) => h.assetClass),
    byAccount: buildAllocation(holdings, (h) => accountNames.get(h.accountId) ?? "Unknown account"),
    bySymbol: buildAllocation(holdings, (h) => h.symbol),
  };
}
