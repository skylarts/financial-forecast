import type { ISODate } from "@/domain";

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
}

export interface SymbolHistory {
  symbol: string;
  points: PricePoint[];
}

/**
 * Symbols are interpolated into an outbound URL, so the accepted shape is
 * locked down to what a real ticker can contain. Anything else is rejected
 * rather than escaped -- there is no legitimate ticker this excludes.
 */
const SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.\-^]{0,11}$/;

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

function isoFromEpochSeconds(seconds: number): ISODate {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

interface ChartMeta {
  regularMarketPrice?: number;
  regularMarketTime?: number;
  longName?: string;
  shortName?: string;
}

interface ChartResult {
  meta?: ChartMeta;
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
}

async function fetchChart(symbol: string, range: string): Promise<ChartResult | null> {
  if (!isValidSymbol(symbol)) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=${range}&interval=1d`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { chart?: { result?: ChartResult[] } };
    return body.chart?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Latest price for one symbol, or null when the feed doesn't know it.
 *
 * Null rather than a thrown error on failure: a missing quote degrades one row
 * of the holdings table, while an exception would take the whole page down over
 * a single delisted ticker.
 */
export async function fetchQuote(symbol: string): Promise<Quote | null> {
  const key = symbol.toUpperCase();
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < QUOTE_TTL_MS) return cached.value;

  const result = await fetchChart(symbol, "5d");
  const price = result?.meta?.regularMarketPrice;
  if (typeof price !== "number") return null;

  const quote: Quote = {
    symbol: key,
    price,
    date: isoFromEpochSeconds(result?.meta?.regularMarketTime ?? Date.now() / 1000),
    name: result?.meta?.longName ?? result?.meta?.shortName ?? "",
  };
  quoteCache.set(key, { value: quote, fetchedAt: Date.now() });
  return quote;
}

/** Daily closes for one symbol, oldest first. Empty when the feed has nothing. */
export async function fetchHistory(symbol: string, range = "10y"): Promise<SymbolHistory> {
  const key = `${symbol.toUpperCase()}::${range}`;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) return cached.value;

  const result = await fetchChart(symbol, range);
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

  const history: SymbolHistory = { symbol: symbol.toUpperCase(), points };
  if (points.length > 0) historyCache.set(key, { value: history, fetchedAt: Date.now() });
  return history;
}
