import {
  isOptionSymbol,
  normalizeSymbol,
  type InstrumentType,
  type Portfolio,
  type Transaction,
} from "@/domain/portfolio";

/**
 * Every symbol the ledger has ever named, open or long since closed.
 *
 * Deliberately not `symbolsInPortfolio`. That list is scoped to open positions
 * because it feeds the *quote* fetcher, and a sold stock has no price left
 * worth asking for. Classification is the opposite case: a position closed in
 * 2022 still has an asset class and an instrument type, and those are exactly
 * what the Holdings and Performance filters read.
 *
 * Sharing one list between the two meant every closed holding was filed under
 * "Other" and "Untagged" forever, because it was never once looked up -- so
 * picking "ETF" on the performance chart silently dropped years of real
 * history out of it.
 *
 * Costs one pass over the transactions rather than a lot-ledger replay, since
 * "was this ever traded" needs no lot matching.
 */
export function symbolsEverTraded(portfolio: Portfolio): string[] {
  const symbols = new Set<string>();
  for (const tx of portfolio.transactions) {
    if (tx.symbol !== null) symbols.add(normalizeSymbol(tx.symbol));
    // A spinoff's child can be received, held and sold without ever being the
    // symbol on a transaction of its own.
    if (tx.spinoffSymbol) symbols.add(normalizeSymbol(tx.spinoffSymbol));
  }
  return [...symbols];
}

/** Share movements. A symbol the ledger moved in share quantities was an
 *  ordinary security, whatever the feed remembers about it now. */
const SHARE_TYPES = new Set<Transaction["type"]>([
  "buy",
  "sell",
  "reinvest",
  "transfer_in",
  "transfer_out",
  "short_sell",
  "buy_to_cover",
]);

/**
 * The best instrument type available without the feed.
 *
 * For a delisted ticker the feed has genuinely forgotten, the ledger is the
 * only witness left -- and it can still say more than "other". An option is
 * readable from its own symbol, with no lookup at all. Anything else the ledger
 * traded in shares was a stock or a fund, and there is no telling which apart
 * without the feed, so this says "stock": right far more often than not, and
 * always better than the alternative, where the position drops out of every
 * filtered view rather than landing in a slightly wrong bucket.
 *
 * Always recorded as an "auto" answer, so correcting one by hand sticks.
 */
export function inferInstrumentType(
  symbol: string,
  transactions: readonly Transaction[],
): InstrumentType {
  if (isOptionSymbol(symbol)) return "option";
  const traded = transactions.some(
    (tx) => tx.symbol !== null && normalizeSymbol(tx.symbol) === symbol && SHARE_TYPES.has(tx.type),
  );
  return traded ? "stock" : "other";
}
