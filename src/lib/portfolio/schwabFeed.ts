import type { ISODate } from "@/domain";
import {
  isValidSymbol,
  type MarketDataProvider,
  type PricePoint,
  type ProviderOutcome,
  type Quote,
  type SymbolHistory,
} from "./marketDataProvider";
import { schwabAccessToken, schwabConfigured } from "./schwabAuth";
import { fromSchwabSymbol, toSchwabSymbol } from "./schwabSymbol";

/**
 * Schwab as a price feed.
 *
 * Preferred for quotes: the prices are the user's own broker's, and Schwab
 * states the prior session's close outright where the other feed has to have
 * it inferred off a daily series.
 *
 * Deliberately *not* preferred for history, even though it serves candles
 * happily. Schwab adjusts historical closes for splits but never reports that
 * a split happened, and the ledger needs the events themselves to put a past
 * close back into the shares actually held that day. A Schwab history is
 * therefore a fallback for closes only, and says so via `splitsKnown: false`.
 */

const MARKET_DATA_BASE = "https://api.schwabapi.com/marketdata/v1";
const TIMEOUT_MS = 10_000;

export const SCHWAB_SOURCE = "schwab";

async function getJson<T>(path: string, params: URLSearchParams): Promise<T | null | "unknown"> {
  const token = await schwabAccessToken();
  if (!token) return null;

  const response = await fetch(`${MARKET_DATA_BASE}${path}?${params}`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // Schwab's considered answer that the instrument does not exist. Retrying it
  // only burns the rate limit, which is per-minute and shared with the
  // transaction sync.
  if (response.status === 404) return "unknown";
  if (!response.ok) return null;
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Quotes                                                                      */
/* -------------------------------------------------------------------------- */

interface SchwabQuoteEntry {
  symbol?: string;
  assetMainType?: string;
  reference?: { description?: string };
  quote?: {
    lastPrice?: number;
    closePrice?: number;
    /** Mutual funds price once a day and report a NAV rather than a last trade. */
    nAV?: number;
    quoteTime?: number;
    tradeTime?: number;
  };
  fundamental?: { lastPrice?: number; nAV?: number };
}

type QuoteBody = Record<string, SchwabQuoteEntry | undefined> & {
  errors?: unknown;
};

/**
 * Schwab prices many symbols in one request, which the other feed cannot do at
 * all. Rather than change the provider interface for it, symbols asked for in
 * the same tick are coalesced here into a single upstream call: a sixty-holding
 * refresh becomes one request instead of sixty, well under a per-minute limit
 * the transaction sync also draws on.
 */
let queued: string[] = [];
let inFlight: Promise<QuoteBody | null | "unknown"> | null = null;

/** Symbols per upstream request, to keep the query string within limits. */
const MAX_SYMBOLS_PER_REQUEST = 100;

async function requestQuotes(symbols: readonly string[]): Promise<QuoteBody | null | "unknown"> {
  const merged: QuoteBody = {};
  let sawFailure = false;
  let sawBody = false;

  for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_REQUEST) {
    const chunk = symbols.slice(i, i + MAX_SYMBOLS_PER_REQUEST);
    const body = await getJson<QuoteBody>(
      "/quotes",
      new URLSearchParams({ symbols: chunk.join(","), fields: "quote,reference" }),
    );
    // A 404 on a multi-symbol request means the whole batch missed, which is
    // not the same as any one symbol being bad -- fold it in as a non-answer
    // and let the per-symbol lookup below report unknown.
    if (body === null) sawFailure = true;
    else if (body !== "unknown") {
      sawBody = true;
      Object.assign(merged, body);
    }
  }

  if (!sawBody) return sawFailure ? null : "unknown";
  return merged;
}

function enqueue(schwabSymbol: string): Promise<QuoteBody | null | "unknown"> {
  queued.push(schwabSymbol);
  if (!inFlight) {
    inFlight = new Promise((resolve) => {
      // One turn of the event loop is enough to collect a fan-out that was
      // dispatched with Promise.all, without adding latency anyone can feel.
      setTimeout(() => {
        const batch = queued;
        queued = [];
        inFlight = null;
        resolve(requestQuotes(batch));
      }, 0);
    });
  }
  return inFlight;
}

function isoFromEpochMs(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10) as ISODate;
}

/**
 * Schwab's `closePrice` does not mean the same thing for every asset type, and
 * the difference is silent.
 *
 * On an equity it is the *previous* session's close, which is exactly the
 * figure a day move is measured against. On an index it is *today's* close --
 * identical to `lastPrice` once the session ends, with `netChange` reported as
 * 0. Reading it the same way for both is what made every benchmark in the
 * market strip print 0.00%: a real -0.25% day rendered as no move at all.
 *
 * Rather than guess a prior close for indexes from fields that do not carry
 * one, they are handed back to the chain unanswered so the public feed prices
 * them -- it tracks indexes correctly and is the only consumer of them here.
 * Schwab keeps everything a portfolio can actually hold.
 */
function isIndex(entry: SchwabQuoteEntry): boolean {
  return entry.assetMainType === "INDEX";
}

function quoteFrom(entry: SchwabQuoteEntry, symbol: string): Quote | null {
  const quote = entry.quote ?? {};
  // A fund quotes its NAV and nothing else on a day it hasn't struck one; the
  // last trade is the right answer whenever there is one.
  const price = quote.lastPrice ?? quote.nAV ?? entry.fundamental?.lastPrice ?? entry.fundamental?.nAV;
  if (typeof price !== "number" || price <= 0) return null;

  // `closePrice` is the previous session's close outright. This is the one
  // place Schwab is plainly better than the alternative, where the same figure
  // has to be recovered by walking a daily series backwards.
  const previous = quote.closePrice;

  return {
    symbol,
    price,
    date: isoFromEpochMs(quote.tradeTime ?? quote.quoteTime ?? Date.now()),
    name: entry.reference?.description ?? "",
    previousClose: typeof previous === "number" && previous > 0 ? previous : null,
    source: SCHWAB_SOURCE,
  };
}

async function fetchQuote(symbol: string): Promise<ProviderOutcome<Quote>> {
  if (!isValidSymbol(symbol)) return { status: "unknown_symbol" };

  const schwabSymbol = toSchwabSymbol(symbol);
  const body = await enqueue(schwabSymbol);
  if (body === null) return { status: "fetch_failed" };
  if (body === "unknown") return { status: "unknown_symbol" };

  // Schwab keys the response by its own spelling, so the padded contract and
  // the dollar-prefixed index come back exactly as they were sent.
  const entry = body[schwabSymbol] ?? body[symbol.toUpperCase()];
  if (!entry) return { status: "unknown_symbol" };

  // Declining an index is not a failure -- it is a deferral to the feed that
  // reports one properly. See `isIndex`.
  if (isIndex(entry)) return { status: "unknown_symbol" };

  const quote = quoteFrom(entry, symbol.toUpperCase());
  return quote ? { status: "ok", value: quote } : { status: "unknown_symbol" };
}

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

interface SchwabCandle {
  close?: number;
  /** Epoch milliseconds, unlike the other feed's seconds. */
  datetime?: number;
}

interface HistoryBody {
  candles?: SchwabCandle[];
  empty?: boolean;
}

/**
 * The app's ranges in Schwab's period vocabulary. Schwab takes a period type
 * and a count from a fixed set rather than a single token, and rejects a count
 * that isn't on its list -- there is no 4-year request.
 */
const RANGE_TO_PERIOD: Record<string, { periodType: string; period: string }> = {
  "1mo": { periodType: "month", period: "1" },
  "3mo": { periodType: "month", period: "3" },
  "6mo": { periodType: "month", period: "6" },
  ytd: { periodType: "ytd", period: "1" },
  "1y": { periodType: "year", period: "1" },
  "2y": { periodType: "year", period: "2" },
  "5y": { periodType: "year", period: "5" },
  "10y": { periodType: "year", period: "10" },
  // Twenty years is the deepest Schwab serves, so it stands in for "max".
  max: { periodType: "year", period: "20" },
};

async function fetchHistory(symbol: string, range: string): Promise<ProviderOutcome<SymbolHistory>> {
  if (!isValidSymbol(symbol)) return { status: "unknown_symbol" };

  const period = RANGE_TO_PERIOD[range];
  if (!period) return { status: "unknown_symbol" };

  const body = await getJson<HistoryBody>(
    "/pricehistory",
    new URLSearchParams({
      symbol: toSchwabSymbol(symbol),
      periodType: period.periodType,
      period: period.period,
      frequencyType: "daily",
      frequency: "1",
      needExtendedHoursData: "false",
    }),
  );

  if (body === null) return { status: "fetch_failed" };
  if (body === "unknown") return { status: "unknown_symbol" };

  const points: PricePoint[] = [];
  for (const candle of body.candles ?? []) {
    if (typeof candle.close !== "number" || typeof candle.datetime !== "number") continue;
    points.push({ date: isoFromEpochMs(candle.datetime), close: candle.close });
  }

  // An empty series is as useless to the caller as a failed request, and the
  // caller's next move should be the same: ask the other feed.
  if (points.length === 0) return { status: "unknown_symbol" };

  return {
    status: "ok",
    value: {
      symbol: symbol.toUpperCase(),
      points,
      // Schwab adjusts the closes above for splits but never says a split
      // occurred, and there is no other endpoint that will. Reporting an empty
      // list as though it were an answer is what would let the engine read a
      // pre-split close as the price the ledger's own shares traded at.
      splits: [],
      splitsKnown: false,
    },
  };
}

export const schwabProvider: MarketDataProvider = {
  name: SCHWAB_SOURCE,
  configured: schwabConfigured,
  quote: fetchQuote,
  history: fetchHistory,
};

/** Test seam: drops the pending coalescing batch between cases. */
export function resetSchwabFeedQueue(): void {
  queued = [];
  inFlight = null;
}

export { fromSchwabSymbol, toSchwabSymbol };
