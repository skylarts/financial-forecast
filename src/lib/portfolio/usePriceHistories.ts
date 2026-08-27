"use client";

import { useEffect, useMemo, useState } from "react";
import type { ISODate } from "@/domain";
import type { PricePoint, SplitEvent } from "@/engine/portfolio/performance";
import { chunkSymbols } from "./historyBatch";
import { coversRequest, getCachedHistories, putCachedHistories } from "./priceHistoryCache";

/** Stable empty maps, so a render with nothing loaded doesn't invalidate every
 *  memo downstream by handing them a fresh reference each time. */
const EMPTY_HISTORIES: Map<string, PricePoint[]> = new Map();
const EMPTY_SPLITS: Map<string, SplitEvent[]> = new Map();

interface FetchedPrices {
  histories: Map<string, PricePoint[]>;
  splits: Map<string, SplitEvent[]>;
  skipped: string[];
}

/**
 * What the last few requests came back with, held at module scope so it
 * survives the components that asked for it unmounting.
 *
 * The portfolio's tabs are siblings that mount and unmount rather than hide,
 * so switching to Holdings and back used to throw away years of daily closes
 * and refetch every one of them -- the same cost as the very first visit,
 * every time. Component state can't survive that unmount; a module-level map
 * can, because the module itself stays loaded for the life of the page.
 *
 * Being module-level rather than per-component is also what lets the header's
 * summary and the Performance tab share one fetch when they ask the same
 * question, instead of each paying for the same years of closes.
 *
 * Bounded and evicted oldest-write-first rather than unbounded: a session
 * that tries a lot of different account scopes or benchmark combinations
 * makes a lot of distinct request keys, and this is a cache, not a ledger of
 * everything ever fetched. Reads deliberately don't bump recency -- that
 * would be a mutation during render, which a pure lookup should not be doing
 * -- so eviction is by write order. Close enough for a handful of keys in one
 * person's session.
 */
const CACHE_LIMIT = 20;
const priceRequestCache = new Map<string, FetchedPrices>();

function cachePut(key: string, value: FetchedPrices): void {
  priceRequestCache.delete(key);
  priceRequestCache.set(key, value);
  if (priceRequestCache.size > CACHE_LIMIT) {
    const oldest = priceRequestCache.keys().next().value;
    if (oldest !== undefined) priceRequestCache.delete(oldest);
  }
}

export interface LoadedHistories {
  histories: Map<string, PricePoint[]>;
  /** The feed's split calendar, which sets the units its closes are quoted in. */
  splits: Map<string, SplitEvent[]>;
  /** Symbols the server refused to fetch because the request was over its cap. */
  skipped: string[];
  loading: boolean;
  failed: boolean;
}

/**
 * Daily closes for `symbols`, back to `from`, from whichever of the three
 * caches can answer soonest: this module's, the browser's IndexedDB store, or
 * the feed.
 *
 * `symbols` is treated as a priority order -- the batch route caps how many it
 * will fetch, so whatever must survive that cap (benchmarks, still-open
 * positions) belongs at the front of the list the caller passes.
 */
export function usePriceHistories(
  symbols: readonly string[],
  range: string,
  from: ISODate,
): LoadedHistories {
  const [loaded, setLoaded] = useState<{ key: string; value: FetchedPrices; failed: boolean } | null>(
    null,
  );

  const requestKey = `${range}::${from}::${symbols.join(",")}`;

  useEffect(() => {
    const [requestRange, windowStart, symbolList] = requestKey.split("::");
    if (!symbolList) return;
    // Already have it -- rendered straight from the cache below, nothing to
    // fetch.
    if (priceRequestCache.has(requestKey)) return;

    let cancelled = false;

    // One request is capped, and a ledger that has held hundreds of positions
    // needs every one of them priced to measure a long window -- a single call
    // would answer for the first slice and report the rest as skipped, leaving
    // the series to value the remainder at the last figure paid. The groups go
    // one after another rather than at once: the route already fans each one
    // out across the feed, and firing them in parallel is what the cap exists
    // to prevent.
    (async () => {
      const wanted = symbolList.split(",");
      const histories = new Map<string, PricePoint[]>();
      const splits = new Map<string, SplitEvent[]>();
      const skipped: string[] = [];
      try {
        // Daily closes outlive the browser tab that fetched them, so a symbol
        // this window already has a wide-enough, fresh-enough entry for
        // (persisted across the last reload, not just this session) never
        // needs to touch the network at all -- only what's actually missing
        // does, and it's what the cap below is spent on.
        const cached = await getCachedHistories(wanted.map((symbol) => ({ symbol, range: requestRange })));
        if (cancelled) return;
        const needsFetch: string[] = [];
        for (const symbol of wanted) {
          const entry = cached.get(symbol);
          if (entry && coversRequest(entry, windowStart)) {
            histories.set(symbol, entry.points);
            splits.set(symbol, entry.splits);
          } else {
            needsFetch.push(symbol);
          }
        }

        const freshEntries = new Map<string, { points: PricePoint[]; splits: SplitEvent[] }>();
        for (const chunk of chunkSymbols(needsFetch)) {
          const response = await fetch(
            `/api/prices/history/batch?symbols=${encodeURIComponent(chunk.join(","))}&range=${requestRange}&from=${windowStart}`,
          );
          if (!response.ok) throw new Error(String(response.status));
          const body: {
            histories?: Record<string, PricePoint[]>;
            splits?: Record<string, SplitEvent[]>;
            skipped?: string[];
          } = await response.json();
          if (cancelled) return;
          for (const [symbol, points] of Object.entries(body.histories ?? {})) {
            histories.set(symbol, points);
          }
          for (const [symbol, events] of Object.entries(body.splits ?? {})) {
            splits.set(symbol, events);
          }
          for (const symbol of Object.keys(body.histories ?? {})) {
            freshEntries.set(symbol, { points: histories.get(symbol) ?? [], splits: splits.get(symbol) ?? [] });
          }
          skipped.push(...(body.skipped ?? []));
        }
        if (!cancelled) {
          // Not cached until the whole chunked fetch succeeds -- a partial
          // result cached mid-failure would be indistinguishable from a
          // complete one on the next visit.
          cachePut(requestKey, { histories, splits, skipped });
          setLoaded({ key: requestKey, value: { histories, splits, skipped }, failed: false });
          // Fire-and-forget: persisting is for the *next* reload, so nothing
          // here should wait on it.
          void putCachedHistories(requestRange, windowStart, freshEntries);
        }
      } catch {
        if (!cancelled) {
          setLoaded({
            key: requestKey,
            value: { histories: new Map(), splits: new Map(), skipped: [] },
            failed: true,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  // A cached hit for this exact request wins over whatever `loaded` still
  // holds from state -- state only lags one render behind the cache anyway
  // (the fetch effect writes both together), and reading the cache directly
  // is what makes a remounted consumer render already-fetched data on its very
  // first paint instead of an empty chart while the effect re-fires.
  const cachedForKey = priceRequestCache.get(requestKey);

  // Derived from what arrived rather than tracked separately, so a slow request
  // for the previous window can't land after a newer one and leave the caller
  // showing one window's prices under another window's label.
  const stateForKey = loaded?.key === requestKey ? loaded : undefined;
  const settled = cachedForKey !== undefined || stateForKey !== undefined;

  const histories = useMemo(
    () => cachedForKey?.histories ?? stateForKey?.value.histories ?? EMPTY_HISTORIES,
    [cachedForKey, stateForKey],
  );
  const splits = useMemo(
    () => cachedForKey?.splits ?? stateForKey?.value.splits ?? EMPTY_SPLITS,
    [cachedForKey, stateForKey],
  );

  return {
    histories,
    splits,
    skipped: cachedForKey?.skipped ?? stateForKey?.value.skipped ?? [],
    loading: symbols.length > 0 && !settled,
    failed: cachedForKey === undefined && (stateForKey?.failed ?? false),
  };
}
