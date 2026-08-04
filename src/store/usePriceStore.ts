"use client";

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { PriceMap } from "@/engine/portfolio/metrics";

interface FeedQuote {
  price: number;
  date: string;
  name: string;
}

interface PriceState {
  quotes: Record<string, FeedQuote>;
  /** Symbols the feed had no price for, so the UI can say so once. */
  missing: string[];
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
  missing: [],
  loading: false,
  lastFetchedAt: null,

  fetchQuotes: async (symbols, force = false) => {
    const { quotes, lastFetchedAt, loading } = get();
    if (loading) return;

    const wanted = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))];
    const stale = lastFetchedAt === null || Date.now() - lastFetchedAt > REFRESH_AFTER_MS;
    const needed = force || stale ? wanted : wanted.filter((s) => !(s in quotes));
    if (needed.length === 0) return;

    set({ loading: true });
    try {
      const response = await fetch(`/api/prices/quotes?symbols=${encodeURIComponent(needed.join(","))}`);
      if (!response.ok) throw new Error(`Quote request failed: ${response.status}`);
      const body = (await response.json()) as { quotes: Record<string, FeedQuote>; missing: string[] };
      set((state) => ({
        quotes: { ...state.quotes, ...body.quotes },
        missing: body.missing ?? [],
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
  missing: string[];
  refresh: () => void;
} {
  const quotes = usePriceStore((s) => s.quotes);
  const loading = usePriceStore((s) => s.loading);
  const missing = usePriceStore((s) => s.missing);
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

  return {
    prices,
    loading,
    missing,
    refresh: () => void fetchQuotes(key ? key.split(",") : [], true),
  };
}
