import type { ISODate } from "@/domain";
import {
  isValidSymbol,
  type MarketDataProvider,
  type PricePoint,
  type ProviderOutcome,
  type Quote,
  type SplitEvent,
  type SymbolHistory,
} from "./marketDataProvider";

/**
 * The public chart feed, as a price provider.
 *
 * Always available -- it needs no credentials, which is what makes it the
 * failsafe underneath Schwab and the whole feed for anyone who never connects
 * a brokerage. It is also the *preferred* source for history, because it
 * reports corporate actions and Schwab does not.
 *
 * The endpoint is undocumented and answers in its own shape, so everything
 * about that shape is confined to this file.
 */

export const YAHOO_SOURCE = "yahoo";

function isoFromEpochSeconds(seconds: number): ISODate {
  return new Date(seconds * 1000).toISOString().slice(0, 10) as ISODate;
}

interface ChartMeta {
  regularMarketPrice?: number;
  regularMarketTime?: number;
  /** Not the prior session's close -- see `priorSessionClose`. This is the
   *  close before the *requested range* begins. */
  chartPreviousClose?: number;
  /** The plain quote field. Absent from the chart endpoint's meta in
   *  practice, kept as a fallback for when the feed does send it. */
  previousClose?: number;
  longName?: string;
  shortName?: string;
  instrumentType?: string;
}

export interface ChartResult {
  meta?: ChartMeta;
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
  events?: {
    dividends?: Record<string, { amount?: number; date?: number }>;
    splits?: Record<string, { numerator?: number; denominator?: number; date?: number }>;
  };
}

/**
 * The prior session's close, read off the daily series.
 *
 * `chartPreviousClose` is named as though it were this and is not: it is the
 * close before the *requested range* starts. A quote asks for five days, so
 * reading that field reported a five-day move under a "Today" label -- ORR
 * showed +3.06% on a day it fell 0.33%. The series carries the real answer.
 *
 * The last bar is the current session (while the market is open its close is
 * the live price), so the comparison is against the last bar dated strictly
 * before it. Before the open that resolves to the previous session's move,
 * which is what a broker shows at that hour too.
 */
export function priorSessionClose(result: ChartResult): number | null {
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const marketTime = result.meta?.regularMarketTime;

  if (typeof marketTime === "number" && timestamps.length === closes.length) {
    const asOf = isoFromEpochSeconds(marketTime);
    for (let i = timestamps.length - 1; i >= 0; i--) {
      const close = closes[i];
      if (typeof close !== "number" || close <= 0) continue;
      if (isoFromEpochSeconds(timestamps[i]) >= asOf) continue;
      return close;
    }
  }

  // A symbol listed inside the window has no prior session in the series. The
  // plain quote field is right when the feed sends it; otherwise say nothing
  // rather than print a move measured against the wrong day.
  const previous = result.meta?.previousClose;
  return typeof previous === "number" && previous > 0 ? previous : null;
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

async function requestChart(symbol: string, range: string, events = ""): Promise<ChartOutcome> {
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

  // The feed answers 200 with an error body for a delisted or expired symbol --
  // an expired option contract lands here every time.
  return body.chart?.error ? { status: "unknown_symbol" } : { status: "fetch_failed" };
}

/**
 * One chart request, retried through transient failures with a backoff.
 *
 * The retry is the fix for prices that "just don't show up": a single throttled
 * or dropped request used to blank the row until the next manual refresh.
 */
async function fetchChart(symbol: string, range: string, events = ""): Promise<ChartOutcome> {
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

async function fetchQuote(symbol: string): Promise<ProviderOutcome<Quote>> {
  const outcome = await fetchChart(symbol, "5d");
  if (outcome.status !== "ok") return { status: outcome.status };

  const meta = outcome.result.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== "number") return { status: "unknown_symbol" };

  return {
    status: "ok",
    value: {
      symbol: symbol.toUpperCase(),
      price,
      date: isoFromEpochSeconds(meta?.regularMarketTime ?? Date.now() / 1000),
      name: meta?.longName ?? meta?.shortName ?? "",
      previousClose: priorSessionClose(outcome.result),
      source: YAHOO_SOURCE,
    },
  };
}

async function fetchHistory(symbol: string, range: string): Promise<ProviderOutcome<SymbolHistory>> {
  // Splits ride along on the request that was already being made. They are not
  // optional detail: every close below is quoted in today's shares, so without
  // them a price from before a split cannot be put back into the shares the
  // ledger was actually holding at the time. This is the reason this feed
  // leads on history even where Schwab is connected.
  const outcome = await fetchChart(symbol, range, "split");
  if (outcome.status !== "ok") return { status: outcome.status };

  const timestamps = outcome.result.timestamp ?? [];
  const closes = outcome.result.indicators?.quote?.[0]?.close ?? [];

  const points: PricePoint[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    // The feed emits nulls for halted or untraded days; carrying them into the
    // chart would punch gaps through the price line.
    if (typeof close !== "number") continue;
    points.push({ date: isoFromEpochSeconds(timestamps[i]), close });
  }

  // An empty series is as useless to the caller as a failed request. Reported
  // as unknown so the chain moves on rather than caching nothing.
  if (points.length === 0) return { status: "unknown_symbol" };

  return {
    status: "ok",
    value: {
      symbol: symbol.toUpperCase(),
      points,
      splits: splitsFrom(outcome.result),
      splitsKnown: true,
    },
  };
}

export const yahooProvider: MarketDataProvider = {
  name: YAHOO_SOURCE,
  // No credentials to be missing, which is exactly why this is the failsafe.
  configured: () => true,
  quote: fetchQuote,
  history: fetchHistory,
};
