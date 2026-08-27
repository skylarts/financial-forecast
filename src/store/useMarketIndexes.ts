"use client";

import { useEffect } from "react";
import { create } from "zustand";

/**
 * The four indexes the market strip quotes, in the order they read.
 *
 * The feed's own index symbols rather than the ETFs that track them: SPY is a
 * fund with its own flows and expense ratio, and on a volatile day it does not
 * print the same move the S&P did. A row labelled "S&P 500" should be the S&P
 * 500.
 */
export const MARKET_INDEXES = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "NASDAQ" },
  { symbol: "^DJI", label: "DOW" },
  { symbol: "^RUT", label: "Russell" },
] as const;

export interface IndexQuote {
  symbol: string;
  label: string;
  /** Today's move as a fraction. Null until quoted, or when the feed gave no
   *  previous close to measure the day against. */
  changePct: number | null;
}

interface MarketIndexState {
  changes: Record<string, number | null>;
  loading: boolean;
  fetchedAt: number | null;
  fetchIndexes: (force?: boolean) => Promise<void>;
}

/** Matches the quote store's own refresh window -- there is no reason for the
 *  index strip to go back to the feed on a different rhythm than the holdings
 *  beside it. */
const REFRESH_AFTER_MS = 15 * 60 * 1000;

/**
 * Day moves for the broad indexes, kept apart from the portfolio's own quote
 * store on purpose.
 *
 * These symbols are not holdings, so folding them into `usePriceStore` would
 * put them into the scope that store reports `unknown` and `unavailable`
 * against -- and a feed hiccup on `^RUT` would then surface as a banner
 * telling the user one of *their* tickers can't be priced. A failure here is
 * worth exactly one blank row.
 */
export const useMarketIndexStore = create<MarketIndexState>((set, get) => ({
  changes: {},
  loading: false,
  fetchedAt: null,

  fetchIndexes: async (force = false) => {
    const { loading, fetchedAt } = get();
    if (loading) return;
    if (!force && fetchedAt !== null && Date.now() - fetchedAt < REFRESH_AFTER_MS) return;

    set({ loading: true });
    try {
      const symbols = MARKET_INDEXES.map((i) => i.symbol).join(",");
      const response = await fetch(
        `/api/prices/quotes?symbols=${encodeURIComponent(symbols)}`,
        force ? { cache: "no-store" } : undefined,
      );
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as {
        quotes: Record<string, { price: number; previousClose?: number | null }>;
      };
      const changes: Record<string, number | null> = {};
      for (const { symbol } of MARKET_INDEXES) {
        const quote = body.quotes[symbol];
        const previous = quote?.previousClose ?? null;
        changes[symbol] =
          quote && previous !== null && previous > 0 ? quote.price / previous - 1 : null;
      }
      set({ changes, fetchedAt: Date.now() });
    } catch {
      // Leave the last known moves in place. A blank strip is a fine outcome
      // for a failed first fetch; wiping good numbers on a later blip is not.
      set({ fetchedAt: Date.now() });
    } finally {
      set({ loading: false });
    }
  },
}));

/** The index strip's rows, fetched on mount and refreshable on demand. */
export function useMarketIndexes(): { indexes: IndexQuote[]; refresh: () => void } {
  const changes = useMarketIndexStore((s) => s.changes);
  const fetchIndexes = useMarketIndexStore((s) => s.fetchIndexes);

  useEffect(() => {
    void fetchIndexes();
  }, [fetchIndexes]);

  return {
    indexes: MARKET_INDEXES.map(({ symbol, label }) => ({
      symbol,
      label,
      changePct: changes[symbol] ?? null,
    })),
    refresh: () => void fetchIndexes(true),
  };
}
