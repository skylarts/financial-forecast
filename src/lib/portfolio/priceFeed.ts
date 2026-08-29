import type { ISODate } from "@/domain";
import { isExpiredOption } from "@/domain/portfolio";
import {
  firstAnswer,
  type MarketDataProvider,
  type Quote,
  type QuoteFailure,
  type SymbolHistory,
} from "./marketDataProvider";
import { schwabProvider } from "./schwabFeed";
import { yahooProvider } from "./yahooFeed";

export {
  isValidSymbol,
  type PricePoint,
  type Quote,
  type QuoteFailure,
  type SplitEvent,
  type SymbolHistory,
} from "./marketDataProvider";

/**
 * Prices, from whichever feed can supply them.
 *
 * This module owns everything that is true regardless of which feed answered:
 * the caches, the fan-out limit, the dead-contract short-circuits, and the
 * decision to serve a stale price rather than a blank cell. The feeds
 * themselves live in `schwabFeed` and `yahooFeed` behind a common interface.
 *
 * The two orders below are the substance of the arrangement, and they are
 * deliberately different.
 */

/**
 * Quotes prefer Schwab: the prices are the user's own broker's, and Schwab
 * states the prior session's close outright instead of leaving it to be
 * recovered from a daily series.
 */
const QUOTE_PROVIDERS: readonly MarketDataProvider[] = [schwabProvider, yahooProvider];

/**
 * History prefers the public feed, which reads backwards from the quote order
 * on purpose. Schwab serves candles adjusted for splits but will not say a
 * split happened, and the events are what let a past close be put back into
 * the shares the ledger actually held that day. Schwab still stands behind it
 * as a source of closes when the public feed is unreachable -- a history with
 * no split events is worth more than no history, and it is labelled
 * `splitsKnown: false` so nothing downstream mistakes the silence for a "no".
 */
const HISTORY_PROVIDERS: readonly MarketDataProvider[] = [yahooProvider, schwabProvider];

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/**
 * Process-local caches. The feeds throttle bursts and Schwab's limit is shared
 * with the transaction sync, while the portfolio page re-renders far more often
 * than daily closes change. History is cached far longer than quotes because
 * past closes never move.
 */
const quoteCache = new Map<string, CacheEntry<Quote>>();
const historyCache = new Map<string, CacheEntry<SymbolHistory>>();
const QUOTE_TTL_MS = 15 * 60 * 1000;
const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How long a cached quote stays usable as a fallback after a failed refetch.
 * Well past the TTL: a day-old price on a labelled row beats a blank cell and a
 * position silently valued at cost basis.
 */
const STALE_FALLBACK_MS = 72 * 60 * 60 * 1000;

/**
 * `Cache-Control` for the price routes, mirroring the TTLs above so the
 * browser's own HTTP cache and this process's in-memory one agree on how
 * fresh each kind of data needs to be. `private` because there is no shared
 * cache in front of this app worth serving out of -- the only cache these
 * headers are for is the requesting browser's own.
 *
 * `stale-while-revalidate` lets a request past `max-age` still answer
 * instantly from the stale copy while a background refetch brings it current,
 * rather than the caller blocking on the network the moment the age ticks
 * over.
 */
export const HISTORY_CACHE_CONTROL = `private, max-age=${Math.floor(HISTORY_TTL_MS / 1000)}, stale-while-revalidate=${Math.floor(HISTORY_TTL_MS / 1000)}`;
export const QUOTE_CACHE_CONTROL = `private, max-age=${Math.floor(QUOTE_TTL_MS / 1000)}, stale-while-revalidate=${Math.floor(QUOTE_TTL_MS / 1000)}`;

function today(): ISODate {
  return new Date().toISOString().slice(0, 10) as ISODate;
}

export interface QuoteResult {
  quote: Quote | null;
  failure: QuoteFailure | null;
}

/**
 * Latest price for one symbol.
 *
 * A failure degrades rather than throws: a missing quote costs one row of the
 * holdings table, while an exception would take the whole page down over a
 * single delisted ticker. When a live fetch fails but a recent price is still
 * cached, that price is served flagged `stale` -- an old number the UI can
 * label is strictly better than no number at all.
 */
export async function fetchQuoteResult(symbol: string): Promise<QuoteResult> {
  const key = symbol.toUpperCase();
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < QUOTE_TTL_MS) {
    return { quote: cached.value, failure: null };
  }

  // An option contract past its expiry is gone from every feed for good, so the
  // request would only buy doomed retries against each of them in turn. Report
  // it as unknown directly and let the caller value the position from its basis.
  if (isExpiredOption(key, today())) {
    return { quote: null, failure: "unknown_symbol" };
  }

  const outcome = await firstAnswer(QUOTE_PROVIDERS, (provider) => provider.quote(symbol));

  if (outcome.status === "ok") {
    quoteCache.set(key, { value: outcome.value, fetchedAt: Date.now() });
    return { quote: outcome.value, failure: null };
  }

  const failure: QuoteFailure = outcome.status;

  // Fall back to a recent cached price rather than blanking the row. Only for
  // transient failures: a symbol every feed now rejects outright should stop
  // reporting a price, not coast on a cached one indefinitely.
  if (failure === "fetch_failed" && cached && Date.now() - cached.fetchedAt < STALE_FALLBACK_MS) {
    return { quote: { ...cached.value, stale: true }, failure: null };
  }

  return { quote: null, failure };
}

/** Latest price for one symbol, or null when it can't be priced. */
export async function fetchQuote(symbol: string): Promise<Quote | null> {
  return (await fetchQuoteResult(symbol)).quote;
}

/**
 * How many upstream requests may be in flight at once.
 *
 * The feeds throttle bursts, so firing every symbol at once is what turns a
 * large portfolio into a page of missing prices -- the requests rate-limit each
 * other. Small batches keep every symbol under the limit. Schwab coalesces a
 * batch of quotes into one request of its own, so this bound costs it nothing.
 */
const BATCH_SIZE = 8;

/**
 * Runs `work` over every symbol with a bounded fan-out.
 *
 * Every multi-symbol fetch in the app goes through here. Quotes were batched
 * and histories were not, which meant the same ticker could be priced on one
 * screen and blank on another purely because a different screen asked for it
 * alongside thirty others.
 */
async function mapSymbols<T>(
  symbols: readonly string[],
  work: (symbol: string) => Promise<T>,
): Promise<Map<string, T>> {
  const results = new Map<string, T>();

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const settled = await Promise.all(batch.map(work));
    batch.forEach((symbol, index) => results.set(symbol.toUpperCase(), settled[index]));
  }

  return results;
}

export async function fetchQuotes(symbols: readonly string[]): Promise<Map<string, QuoteResult>> {
  return mapSymbols(symbols, fetchQuoteResult);
}

/** Daily closes for many symbols, with the same bounded fan-out as quotes. */
export async function fetchHistories(
  symbols: readonly string[],
  range = "10y",
): Promise<Map<string, SymbolHistory>> {
  return mapSymbols(symbols, (symbol) => fetchHistory(symbol, range));
}

/** Daily closes for one symbol, oldest first. Empty when no feed has anything. */
export async function fetchHistory(symbol: string, range = "10y"): Promise<SymbolHistory> {
  const key = `${symbol.toUpperCase()}::${range}`;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) return cached.value;

  // An option contract past its expiry is gone from the feeds for good, so the
  // request would only buy doomed retries. It matters more here than for
  // quotes: a lifetime window asks for every symbol the ledger ever traded, and
  // on a ledger that writes options that is mostly dead contracts. The series
  // values them from the ledger's own prices, which is where a closed
  // position's figures come from regardless of whether a feed answered.
  if (isExpiredOption(symbol.toUpperCase(), today())) {
    return { symbol: symbol.toUpperCase(), points: [], splits: [], splitsKnown: false };
  }

  const outcome = await firstAnswer(HISTORY_PROVIDERS, (provider) =>
    provider.history(symbol, range),
  );

  // A failed fetch must not overwrite a good cached history with nothing.
  if (outcome.status !== "ok") {
    if (cached) return cached.value;
    return { symbol: symbol.toUpperCase(), points: [], splits: [], splitsKnown: false };
  }

  historyCache.set(key, { value: outcome.value, fetchedAt: Date.now() });
  return outcome.value;
}

/** Test seam: empties the process-local caches between cases. */
export function resetPriceCaches(): void {
  quoteCache.clear();
  historyCache.clear();
}
