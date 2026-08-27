"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeSymbol, type AssetClass, type Exposure, type InstrumentType } from "@/domain/portfolio";
import { usePortfolioStore } from "./usePortfolioStore";

/**
 * Fills in what asset class each holding belongs to, from the feed.
 *
 * Classifying by hand is the kind of chore that never gets done: an
 * unclassified holding drops out of the allocation view entirely, so the
 * allocation view stays empty and nobody notices which exposures they actually
 * hold. The feed already knows a fund's category and a company's sector and
 * exchange, so the app asks.
 *
 * A class the user set by hand is never overwritten -- see `assetClassSource`
 * on the security record. Automatic answers are exactly that: a starting point
 * that stops being automatic the moment it's disagreed with.
 */

export interface ResolvedProfile {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Why that class, in one phrase, e.g. "ETF in the Foreign Large Blend category". */
  basis: string;
  exposures: Exposure[];
  instrumentType: InstrumentType;
  found: boolean;
}

export function useSecurityProfiles(symbols: readonly string[]): {
  profiles: Record<string, ResolvedProfile>;
  loading: boolean;
} {
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const upsertSecurity = usePortfolioStore((s) => s.upsertSecurity);
  const hasHydrated = usePortfolioStore((s) => s.hasHydrated);

  const [profiles, setProfiles] = useState<Record<string, ResolvedProfile>>({});
  const [loading, setLoading] = useState(false);
  /** Symbols already asked about this session, so an upsert can't retrigger a fetch. */
  const requested = useRef(new Set<string>());

  /**
   * Symbols that don't need asking about: set by hand, or already answered by
   * the feed on a previous visit. Without this, every reload re-asks the feed
   * about every holding in the portfolio -- the same batch of lookups, with the
   * same answer, every single time. For a large portfolio that's a real amount
   * of traffic landing on the same host the live quotes come from, competing
   * for the same rate limit and making actual price refreshes fail more.
   */
  const settled = useMemo(() => {
    const set = new Set<string>();
    for (const security of portfolio.securities) {
      if (security.assetClassSource === "manual") set.add(normalizeSymbol(security.symbol));
      // An "auto" record with a real class is a feed answer already on file.
      // "other" is left out: that's what an unresolved symbol defaults to, so
      // it's worth asking again rather than treating a miss as permanent.
      else if (security.assetClassSource === "auto" && security.assetClass !== "other") {
        set.add(normalizeSymbol(security.symbol));
      }
    }
    return set;
  }, [portfolio.securities]);

  // A plain string, not the array, so a re-render with the same symbols in the
  // same order doesn't look like a new request to the effect.
  const key = useMemo(
    () =>
      [...new Set(symbols.map(normalizeSymbol).filter(Boolean))]
        .filter((symbol) => !settled.has(symbol))
        .sort()
        .join(","),
    [symbols, settled],
  );

  useEffect(() => {
    if (!hasHydrated || !key) return;

    const wanted = key.split(",").filter((symbol) => !requested.current.has(symbol));
    if (wanted.length === 0) return;
    for (const symbol of wanted) requested.current.add(symbol);

    let cancelled = false;
    setLoading(true);

    void fetch(`/api/symbols/profile?symbols=${encodeURIComponent(wanted.join(","))}`)
      .then((r) => r.json() as Promise<{ profiles: ResolvedProfile[] }>)
      .then((body) => {
        if (cancelled) return;
        const found = (body.profiles ?? []).filter((p) => p.found);
        setProfiles((current) => {
          const next = { ...current };
          for (const profile of found) next[profile.symbol] = profile;
          return next;
        });

        // Read the store fresh rather than closing over it: this lands after an
        // await, and the ledger may have moved on since the effect started.
        const securities = usePortfolioStore.getState().portfolio.securities;
        for (const profile of found) {
          const existing = securities.find((s) => normalizeSymbol(s.symbol) === profile.symbol);
          if (existing?.assetClassSource === "manual") continue;

          const name = existing?.name || profile.name;
          if (existing && existing.assetClass === profile.assetClass && existing.name === name) {
            continue;
          }

          upsertSecurity({
            symbol: profile.symbol,
            name,
            assetClass: profile.assetClass,
            assetClassSource: "auto",
            exposures: profile.exposures,
            instrumentType:
              existing?.instrumentTypeSource === "manual"
                ? existing.instrumentType
                : profile.instrumentType,
            instrumentTypeSource:
              existing?.instrumentTypeSource === "manual" ? "manual" : "auto",
            themes: existing?.themes ?? [],
            manualPrice: existing?.manualPrice ?? null,
            manualPriceDate: existing?.manualPriceDate ?? null,
            lastKnownPrice: existing?.lastKnownPrice ?? null,
            lastKnownPriceDate: existing?.lastKnownPriceDate ?? null,
          });
        }
      })
      .catch(() => {
        // A failed lookup leaves the holdings unclassified, which is exactly
        // where they were. Symbols stay in `requested` so a flaky feed doesn't
        // turn into a retry loop; a reload asks again.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, hasHydrated, upsertSecurity]);

  return { profiles, loading };
}
