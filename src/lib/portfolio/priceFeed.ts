import type { ISODate } from "@/domain";
import { isExpiredOption } from "@/domain/portfolio";

export interface PricePoint {
  date: ISODate;
  close: number;
}

export interface Quote {
  symbol: string;
  price: number;
  date: ISODate;
  /** The feed's own name for the security, used to auto-fill new holdings. */
  name: string;
  /**
   * True when this came from cache after a live refetch failed. The price is
   * real, just older than it looks -- the UI says so rather than presenting a
   * stale number as current.
   */
  stale?: boolean;
}

/**
 * A share split, as the feed records it.
 *
 * `ratio` is how many shares one share became -- 20 for Alphabet's 20-for-1,
 * 0.1 for a one-for-ten reverse. The date is the day the new shares began
 * trading, which is the first day the feed's closes are quoted in them.
 */
export interface SplitEvent {
  date: ISODate;
  ratio: number;
}

export interface SymbolHistory {
  symbol: string;
  points: PricePoint[];
  /**
   * Every split the feed knows of, oldest first.
   *
   * Carried with the history rather than fetched separately because the closes
   * are meaningless without it: the feed quotes all of them in *today's*
   * shares, so a price from before a split is not the price anyone paid that
   * day. Asking for the events costs nothing -- it is a query parameter on the
   * request that was already being made.
   */
  splits: SplitEvent[];
}

/**
 * Why a symbol has no price. The distinction matters: "the feed has never
 * heard of this" is a data-entry problem the user must fix, while "the request
 * failed" is weather and will likely fix itself on the next refresh. Collapsing
 * the two is what made a transient blip look like a bad ticker.
 */
export type QuoteFailure = "unknown_symbol" | "fetch_failed";

/**
 * Symbols are interpolated into an outbound URL, so the accepted shape is
 * locked down to what a real ticker can contain. Anything else is rejected
 * rather than escaped -- there is no legitimate ticker this excludes.
 *
 * The 21-character ceiling is set by OCC option symbology (a six-character
 * root, a six-digit expiry, C or P, an eight-digit strike). The previous
 * 12-character limit silently rejected every option contract before it ever
 * reached the feed.
 */
const SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.\-^]{0,20}$/;

export function isValidSymbol(symbol: string): boolean {
  return SYMBOL_PATTERN.test(symbol);
}

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/**
 * Process-local caches. The upstream feed is unmetered but throttles bursts,
 * and the portfolio page re-renders far more often than daily closes change.
 * History is cached far longer than quotes because past closes never move.
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

function isoFromEpochSeconds(seconds: number): ISODate {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

interface ChartMeta {
  regularMarketPrice?: number;
  regularMarketTime?: number;
  longName?: string;
  shortName?: string;
  instrumentType?: string;
}

interface ChartResult {
  meta?: ChartMeta;
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
  events?: {
    dividends?: Record<string, { amount?: number; date?: number }>;
    splits?: Record<string, { numerator?: number; denominator?: number; date?: number }>;
  };
}

/** Splits out of a chart response, oldest first and ignoring malformed rows. */
function splitsFrom(result: ChartResult): SplitEvent[] {
  const raw = result.events?.splits ?? {};
  const events: SplitEvent[] = [];
  for (const entry of Object.values(raw)) {
    const { numerator, denominator, date } = entry ?? {};
    if (typeof numerator !== "number" || typeof denominator !== "number") continue;
    if (typeof date !== "number" || numerator <= 0 || denominator <= 0) continue;
    const ratio = numerator / denominator;
    // A one-for-one is not a split; it shows up occasionally as a placeholder
    // and would only add a needless breakpoint to the factor series.
    if (ratio === 1) continue;
    events.push({ date: isoFromEpochSeconds(date), ratio });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));
  return events;
}

/** Outcome of one chart request, keeping "no such symbol" apart from "it broke". */
type ChartOutcome =
  | { status: "ok"; result: ChartResult }
  | { status: "unknown_symbol" }
  | { status: "fetch_failed" };

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestChart(
  symbol: string,
  range: string,
  events = "",
): Promise<ChartOutcome> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${range}&interval=1d${events ? `&events=${events}` : ""}`;

  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(10_000),
  });

  // A 404 is the feed's considered answer that the symbol doesn't exist, so
  // retrying it just burns the rate limit. Everything else -- 429, 5xx -- is
  // transient and worth another attempt.
  if (response.status === 404) return { status: "unknown_symbol" };
  if (!response.ok) return { status: "fetch_failed" };

  const body = (await response.json()) as {
    chart?: { result?: ChartResult[]; error?: { code?: string } | null };
  };
  const result = body.chart?.result?.[0];
  if (result) return { status: "ok", result };

  // Yahoo answers 200 with an error body for a delisted or expired symbol --
  // an expired option contract lands here every time.
  return body.chart?.error ? { status: "unknown_symbol" } : { status: "fetch_failed" };
}

/**
 * One chart request, retried through transient failures with a backoff.
 *
 * The retry is the fix for prices that "just don't show up": a single throttled
 * or dropped request used to blank the row until the next manual refresh.
 */
async function fetchChart(
  symbol: string,
  range: string,
  events = "",
): Promise<ChartOutcome> {
  if (!isValidSymbol(symbol)) return { status: "unknown_symbol" };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let outcome: ChartOutcome;
    try {
      outcome = await requestChart(symbol, range, events);
    } catch {
      outcome = { status: "fetch_failed" };
    }

    if (outcome.status !== "fetch_failed") return outcome;
    if (attempt < MAX_ATTEMPTS - 1) await delay(RETRY_BASE_MS * 2 ** attempt);
  }

  return { status: "fetch_failed" };
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

  // An option contract past its expiry is gone from the feed for good, so the
  // request would only buy three doomed retries. Report it as unknown directly
  // and let the caller value the position from its basis.
  if (isExpiredOption(key, new Date().toISOString().slice(0, 10) as ISODate)) {
    return { quote: null, failure: "unknown_symbol" };
  }

  const outcome = await fetchChart(symbol, "5d");

  if (outcome.status === "ok") {
    const price = outcome.result.meta?.regularMarketPrice;
    if (typeof price === "number") {
      const meta = outcome.result.meta;
      const quote: Quote = {
        symbol: key,
        price,
        date: isoFromEpochSeconds(meta?.regularMarketTime ?? Date.now() / 1000),
        name: meta?.longName ?? meta?.shortName ?? "",
      };
      quoteCache.set(key, { value: quote, fetchedAt: Date.now() });
      return { quote, failure: null };
    }
  }

  const failure: QuoteFailure =
    outcome.status === "unknown_symbol" ? "unknown_symbol" : "fetch_failed";

  // Fall back to a recent cached price rather than blanking the row. Only for
  // transient failures: a symbol the feed now rejects outright should stop
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
 * The feed throttles bursts, so firing every symbol at once is what turns a
 * large portfolio into a page of missing prices -- the requests rate-limit each
 * other. Small batches keep every symbol under the limit.
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

/** Dividend events for many symbols, with the same bounded fan-out as quotes. */
export async function fetchDividendsFor(
  symbols: readonly string[],
  range = "10y",
): Promise<Map<string, DividendEvent[]>> {
  return mapSymbols(symbols, (symbol) => fetchDividends(symbol, range));
}

export interface DividendEvent {
  /** Ex-dividend date: own the shares before this and the payment is yours. */
  date: ISODate;
  /** Dollars per share. */
  amount: number;
}

const dividendCache = new Map<string, CacheEntry<DividendEvent[]>>();

/**
 * Every dividend the feed has on record for a symbol, oldest first.
 *
 * Cached as long as price history is: a dividend that has already been declared
 * never changes, and the next one is a quarter away.
 *
 * The dates are ex-dates, not pay dates. That is the one that decides who gets
 * paid -- ownership before the ex-date is what entitles you -- and it is the
 * only one the feed reports.
 */
export async function fetchDividends(symbol: string, range = "10y"): Promise<DividendEvent[]> {
  const key = `${symbol.toUpperCase()}::${range}`;
  const cached = dividendCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) return cached.value;

  const outcome = await fetchChart(symbol, range, "div");
  if (outcome.status !== "ok") return cached?.value ?? [];

  const raw = outcome.result.events?.dividends ?? {};
  const events: DividendEvent[] = [];
  for (const entry of Object.values(raw)) {
    if (typeof entry?.amount !== "number" || typeof entry?.date !== "number") continue;
    if (entry.amount <= 0) continue;
    events.push({ date: isoFromEpochSeconds(entry.date), amount: entry.amount });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));

  // A symbol that genuinely pays nothing caches as an empty list, so it isn't
  // re-asked on every visit. Only a failed request falls back to what's held.
  dividendCache.set(key, { value: events, fetchedAt: Date.now() });
  return events;
}

/** Daily closes for one symbol, oldest first. Empty when the feed has nothing. */
export async function fetchHistory(symbol: string, range = "10y"): Promise<SymbolHistory> {
  const key = `${symbol.toUpperCase()}::${range}`;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) return cached.value;

  // Splits ride along on the request that was already being made. They are not
  // optional detail: every close below is quoted in today's shares, so without
  // them a price from before a split cannot be put back into the shares the
  // ledger was actually holding at the time.
  const outcome = await fetchChart(symbol, range, "split");
  const result = outcome.status === "ok" ? outcome.result : null;
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  const points: PricePoint[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    // The feed emits nulls for halted or untraded days; carrying them into the
    // chart would punch gaps through the price line.
    if (typeof close !== "number") continue;
    points.push({ date: isoFromEpochSeconds(timestamps[i]), close });
  }

  // A failed fetch must not overwrite a good cached history with nothing.
  if (points.length === 0 && cached) return cached.value;

  const history: SymbolHistory = {
    symbol: symbol.toUpperCase(),
    points,
    splits: result ? splitsFrom(result) : [],
  };
  if (points.length > 0) historyCache.set(key, { value: history, fetchedAt: Date.now() });
  return history;
}
