"use client";

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { PriceMap } from "@/engine/portfolio/metrics";

interface FeedQuote {
  price: number;
  date: string;
  name: string;
  /** Served from cache after a failed refresh -- real, but older than it looks. */
  stale?: boolean;
}

interface PriceState {
  quotes: Record<string, FeedQuote>;
  /** Symbols the feed doesn't recognise. These need a fix or a manual price. */
  unknown: string[];
  /** Symbols whose fetch failed. Transient -- a refresh will likely clear them. */
  unavailable: string[];
  loading: boolean;
  lastFetchedAt: number | null;
  fetchQuotes: (symbols: readonly string[], force?: boolean) => Promise<void>;
}

const REFRESH_AFTER_MS = 15 * 60 * 1000;

/**
 * Quotes are session state, not plan data -- deliberately not persisted. A
 * price cached to disk would come back stale on the next visit and silently
 * misvalue the whole portfolio; refetching costs one request.
 */
export const usePriceStore = create<PriceState>((set, get) => ({
  quotes: {},
  unknown: [],
  unavailable: [],
  loading: false,
  lastFetchedAt: null,

  fetchQuotes: async (symbols, force = false) => {
    const { quotes, lastFetchedAt, loading } = get();
    // An in-flight request used to make this a silent no-op, so a second
    // component mounting mid-fetch dropped its symbols and they stayed
    // unpriced until the next manual refresh. Wait and retry instead.
    if (loading) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (get().loading) return;
      return get().fetchQuotes(symbols, force);
    }

    const wanted = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))];
    const expired = lastFetchedAt === null || Date.now() - lastFetchedAt > REFRESH_AFTER_MS;
    const needed = force || expired ? wanted : wanted.filter((s) => !(s in quotes));
    if (needed.length === 0) return;

    set({ loading: true });
    try {
      // A forced refresh (the "Refetch quotes now" button) has to reach the
      // feed, not the browser's own HTTP cache -- the route now sends a
      // Cache-Control header so ordinary polling can be served from it, but a
      // press of that button asking to bypass staleness would otherwise get
      // handed back the very quote it's trying to get past.
      const response = await fetch(
        `/api/prices/quotes?symbols=${encodeURIComponent(needed.join(","))}`,
        force ? { cache: "no-store" } : undefined,
      );
      if (!response.ok) throw new Error(`Quote request failed: ${response.status}`);
      const body = (await response.json()) as {
        quotes: Record<string, FeedQuote>;
        unknown?: string[];
        unavailable?: string[];
      };
      // Scoped to what was actually asked for: a partial refresh must not clear
      // the status of symbols it never requested.
      const requested = new Set(needed);
      const keep = (list: string[]) => list.filter((s) => !requested.has(s));
      set((state) => ({
        quotes: { ...state.quotes, ...body.quotes },
        unknown: [...keep(state.unknown), ...(body.unknown ?? [])],
        unavailable: [...keep(state.unavailable), ...(body.unavailable ?? [])],
        lastFetchedAt: Date.now(),
      }));
    } catch {
      // Leave prior quotes in place; analyzePortfolio falls back to cost basis
      // for anything still unpriced, so the page stays usable offline.
      set({ lastFetchedAt: Date.now() });
    } finally {
      set({ loading: false });
    }
  },
}));

/** Fetches quotes for `symbols` and returns them in the shape the engine wants. */
export function usePrices(symbols: readonly string[]): {
  prices: PriceMap;
  loading: boolean;
  /** Symbols the feed doesn't recognise -- these want a manual price. */
  unknown: string[];
  /** Symbols that failed to fetch -- these usually clear on a refresh. */
  unavailable: string[];
  /** Priced from cache because a refresh failed, so the date is behind. */
  stale: string[];
  refresh: () => void;
} {
  const quotes = usePriceStore((s) => s.quotes);
  const loading = usePriceStore((s) => s.loading);
  const unknown = usePriceStore((s) => s.unknown);
  const unavailable = usePriceStore((s) => s.unavailable);
  const fetchQuotes = usePriceStore((s) => s.fetchQuotes);

  const key = [...symbols].sort().join(",");
  useEffect(() => {
    if (key) void fetchQuotes(key.split(","));
  }, [key, fetchQuotes]);

  const prices = useMemo(() => {
    const map: PriceMap = {};
    for (const [symbol, quote] of Object.entries(quotes)) {
      map[symbol] = { price: quote.price, date: quote.date, name: quote.name };
    }
    return map;
  }, [quotes]);

  const stale = useMemo(
    () => Object.entries(quotes).filter(([, q]) => q.stale).map(([symbol]) => symbol),
    [quotes],
  );

  // Scoped to the symbols actually in view, so a filtered account doesn't warn
  // about tickers it isn't showing.
  const inScope = useMemo(
    () => new Set(key ? key.toUpperCase().split(",") : []),
    [key],
  );

  return {
    prices,
    loading,
    unknown: unknown.filter((s) => inScope.has(s)),
    unavailable: unavailable.filter((s) => inScope.has(s)),
    stale: stale.filter((s) => inScope.has(s)),
    refresh: () => void fetchQuotes(key ? key.split(",") : [], true),
  };
}
