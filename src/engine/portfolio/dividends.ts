import type { ISODate, Id } from "@/domain";
import { normalizeSymbol, type Transaction } from "@/domain/portfolio";

export interface DividendEvent {
  /** Ex-dividend date. */
  date: ISODate;
  /** Dollars per share. */
  amount: number;
}

export interface ProposedDividend {
  /** Stable identity for selection in the review list. */
  key: string;
  accountId: Id;
  symbol: string;
  /** The ex-date, which is also the date the transaction is written with. */
  date: ISODate;
  perShare: number;
  /** Shares held going into the ex-date. Negative on a short position. */
  shares: number;
  /** What was paid. Negative when a short position owed it instead. */
  amount: number;
  sourceHash: string;
}

export interface DividendProposal {
  proposals: ProposedDividend[];
  /**
   * Payments the ledger already accounts for, whether generated here before or
   * imported from a statement. Reported so a run that proposes nothing reads as
   * "already up to date" rather than as a failure.
   */
  skippedExisting: number;
}

/** Marks a row as generated from a specific symbol's specific ex-date. */
export function dividendSourceHash(symbol: string, exDate: ISODate): string {
  return `auto-div:${symbol}:${exDate}`;
}

/**
 * How far around an ex-date to look for a payment the ledger already has.
 *
 * A brokerage records the dividend on its pay date, which trails the ex-date by
 * two to six weeks -- so matching on the date alone would miss every
 * statement-imported dividend and propose a duplicate of it. The window reaches
 * forward far enough to cover that and stops well short of the next quarterly
 * ex-date, so one quarter's payment can never suppress the following one.
 */
const MATCH_BEFORE_DAYS = 5;
const MATCH_AFTER_DAYS = 45;

function shiftDate(date: ISODate, days: number): ISODate {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Whether `otherDate` falls in the pay-date window this engine would treat as
 * the same payment as `exDate`. Shared with the statement importer, which
 * needs the same window in the opposite direction: a statement dividend can
 * land after a sync already proposed and wrote that payment under its ex-date,
 * and nothing about the statement row's own hash would tell the importer that.
 */
export function isSameDividendWindow(exDate: ISODate, otherDate: ISODate): boolean {
  const windowStart = shiftDate(exDate, -MATCH_BEFORE_DAYS);
  const windowEnd = shiftDate(exDate, MATCH_AFTER_DAYS);
  return otherDate >= windowStart && otherDate <= windowEnd;
}

/** Whether a sourceHash marks a transaction this engine generated from the feed. */
export function isAutoDividendHash(hash: string | null): boolean {
  return hash !== null && hash.startsWith("auto-div:");
}

/** Types that already represent a dividend having been received. */
const INCOME_TYPES = new Set(["dividend", "reinvest"]);

/**
 * Running share count per account and symbol, as of the close before a date.
 *
 * Ownership before the ex-date is what entitles you to the payment, so a
 * purchase settled on the ex-date itself earns nothing -- which is why this
 * counts transactions strictly before it rather than up to and including.
 */
function sharesBefore(
  transactions: readonly Transaction[],
  accountId: Id,
  symbol: string,
  exDate: ISODate,
): number {
  let shares = 0;
  for (const tx of transactions) {
    if (tx.date >= exDate) break;
    if (tx.accountId !== accountId || tx.symbol === null) continue;
    if (normalizeSymbol(tx.symbol) !== symbol) continue;

    switch (tx.type) {
      case "buy":
      case "reinvest":
      case "transfer_in":
      case "buy_to_cover":
        shares += tx.quantity;
        break;
      case "sell":
      case "transfer_out":
      case "short_sell":
        shares -= tx.quantity;
        break;
      case "split":
        if (tx.quantity > 0) shares *= tx.quantity;
        break;
      case "option_expire":
      case "option_exercise":
      case "option_assign":
        shares += shares > 0 ? -tx.quantity : tx.quantity;
        break;
      default:
        break;
    }
  }
  return shares;
}

/** Share counts below this are floating-point dust, not a position. */
const EPSILON = 1e-6;

/**
 * Works out which dividends the ledger is missing.
 *
 * Everything needed is already on hand: the feed knows the ex-dates and the
 * per-share amounts, and the ledger knows how many shares were held on each of
 * those days. The multiplication is the easy part -- the work is in not
 * proposing a payment that is already recorded, since these rows are written
 * into the same ledger every other figure is derived from.
 *
 * Nothing is written here. This returns a proposal for review.
 */
export function proposeDividends(
  transactions: readonly Transaction[],
  events: ReadonlyMap<string, readonly DividendEvent[]>,
  options: { accountIds?: readonly Id[] } = {},
): DividendProposal {
  const scoped = options.accountIds
    ? transactions.filter((tx) => options.accountIds!.includes(tx.accountId))
    : [...transactions];
  const ordered = [...scoped].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Which (account, symbol) pairs the ledger has ever touched. A dividend can
  // only be owed where shares were actually held.
  const pairs = new Map<string, { accountId: Id; symbol: string; firstDate: ISODate }>();
  for (const tx of ordered) {
    if (tx.symbol === null) continue;
    const symbol = normalizeSymbol(tx.symbol);
    const key = `${tx.accountId}::${symbol}`;
    if (!pairs.has(key)) pairs.set(key, { accountId: tx.accountId, symbol, firstDate: tx.date });
  }

  const existingHashes = new Set(
    ordered.map((tx) => tx.sourceHash).filter((hash): hash is string => hash !== null),
  );

  const proposals: ProposedDividend[] = [];
  let skippedExisting = 0;

  for (const { accountId, symbol, firstDate } of pairs.values()) {
    const symbolEvents = events.get(symbol);
    if (!symbolEvents) continue;

    // Income already on the books for this position, to match against.
    const recorded = ordered.filter(
      (tx) =>
        tx.accountId === accountId &&
        tx.symbol !== null &&
        normalizeSymbol(tx.symbol) === symbol &&
        INCOME_TYPES.has(tx.type),
    );

    for (const event of symbolEvents) {
      // Nothing was held before the first transaction, so an earlier ex-date is
      // not a missing payment -- it is a payment that was never owed.
      if (event.date <= firstDate) continue;

      const hash = dividendSourceHash(symbol, event.date);
      if (existingHashes.has(hash)) {
        skippedExisting += 1;
        continue;
      }

      const windowStart = shiftDate(event.date, -MATCH_BEFORE_DAYS);
      const windowEnd = shiftDate(event.date, MATCH_AFTER_DAYS);
      if (recorded.some((tx) => tx.date >= windowStart && tx.date <= windowEnd)) {
        skippedExisting += 1;
        continue;
      }

      const shares = sharesBefore(ordered, accountId, symbol, event.date);
      if (Math.abs(shares) < EPSILON) continue;

      proposals.push({
        key: `${accountId}::${symbol}::${event.date}`,
        accountId,
        symbol,
        date: event.date,
        perShare: event.amount,
        shares,
        // A short position owes the dividend rather than receiving it, so the
        // sign follows the shares and the row reads as money out.
        amount: shares * event.amount,
        sourceHash: hash,
      });
    }
  }

  proposals.sort((a, b) =>
    a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date < b.date ? -1 : 1,
  );
  return { proposals, skippedExisting };
}

/** Turns an accepted proposal into the transaction the ledger stores. */
export function toTransaction(proposal: ProposedDividend): Omit<Transaction, "id"> {
  return {
    accountId: proposal.accountId,
    date: proposal.date,
    type: "dividend",
    symbol: proposal.symbol,
    // Shares stay zero: a dividend moves cash, not stock, and a share count
    // here would be replayed as a position change by the lot ledger.
    quantity: 0,
    price: 0,
    amount: proposal.amount,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: `${proposal.perShare.toFixed(4)}/share on ${Math.abs(proposal.shares)} shares, from the price feed`,
    importBatchId: null,
    sourceHash: proposal.sourceHash,
  };
}
