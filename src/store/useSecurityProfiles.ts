"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeSymbol,
  type AssetClass,
  type Exposure,
  type InstrumentType,
  type Security,
} from "@/domain/portfolio";
import { inferInstrumentType } from "@/lib/portfolio/classifiableSymbols";
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

/**
 * How many symbols go in one request. Must stay at or under the route's own
 * MAX_SYMBOLS, which slices the overflow off without complaint.
 */
const REQUEST_CHUNK = 60;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A security record with nothing filled in, so a partial update can be spread
 *  over it without every caller restating all thirteen fields. */
function blankSecurity(symbol: string): Security {
  return {
    symbol,
    name: "",
    assetClass: "other",
    assetClassSource: "auto",
    exposures: [],
    instrumentType: "other",
    instrumentTypeSource: "auto",
    themes: [],
    manualPrice: null,
    manualPriceDate: null,
    lastKnownPrice: null,
    lastKnownPriceDate: null,
    profileCheckedAt: null,
  };
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
      else if (security.assetClassSource === "auto" && security.assetClass !== "other") {
        set.add(normalizeSymbol(security.symbol));
      }
      // Asked before and the feed had nothing. That used to be left unsettled
      // so it would be asked again, which was affordable while only open
      // positions were classified. Across every symbol ever traded it is not:
      // a ledger with hundreds of delisted tickers would re-ask about all of
      // them on every single load, forever, for the same silence.
      else if (security.profileCheckedAt !== null) set.add(normalizeSymbol(security.symbol));
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

  /**
   * Symbols waiting to be asked about, and whether a run is already draining
   * them.
   *
   * A queue rather than a local variable because this effect re-runs *as a
   * direct result of its own writes*: every classified symbol lands in the
   * store, which changes `settled`, which changes `key`. Tying the run to the
   * effect's own cancel token therefore killed it -- the first chunk's upserts
   * re-triggered the effect, the cleanup cancelled the loop mid-flight, and the
   * re-run found every symbol already in `requested` and did nothing. The
   * backfill stopped dead after 60 symbols, silently. Now a re-entrant effect
   * just appends to the queue and the single running loop drains it.
   */
  const queue = useRef<string[]>([]);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hasHydrated || !key) return;

    const wanted = key.split(",").filter((symbol) => !requested.current.has(symbol));
    if (wanted.length === 0) return;
    for (const symbol of wanted) requested.current.add(symbol);
    queue.current.push(...wanted);

    if (running.current) return;
    running.current = true;
    setLoading(true);

    void (async () => {
      try {
        // One chunk at a time, sequentially. The route caps a single request at
        // MAX_SYMBOLS and *silently truncates* past it, so asking about a
        // ledger's worth of closed symbols in one call would have dropped all
        // but the first 60 with nothing to show for it. Going in order also
        // keeps this from arriving as one burst against the same host the live
        // quotes come from.
        while (queue.current.length > 0 && mounted.current) {
          const chunk = queue.current.splice(0, REQUEST_CHUNK);
          const response = await fetch(
            `/api/symbols/profile?symbols=${encodeURIComponent(chunk.join(","))}`,
          );
          const body = (await response.json()) as { profiles: ResolvedProfile[] };
          if (!mounted.current) return;

          const returned = body.profiles ?? [];
          const found = returned.filter((p) => p.found);
          setProfiles((current) => {
            const next = { ...current };
            for (const profile of found) next[profile.symbol] = profile;
            return next;
          });

          // Read the store fresh rather than closing over it: this lands after
          // an await, and the ledger may have moved on since the run started.
          const { portfolio: latest } = usePortfolioStore.getState();
          const securityFor = (symbol: string) =>
            latest.securities.find((s) => normalizeSymbol(s.symbol) === symbol);
          const resolved = new Set(found.map((p) => p.symbol));

          for (const profile of found) {
            const existing = securityFor(profile.symbol);
            if (existing?.assetClassSource === "manual") continue;

            const name = existing?.name || profile.name;
            if (
              existing &&
              existing.profileCheckedAt !== null &&
              existing.assetClass === profile.assetClass &&
              existing.name === name
            ) {
              continue;
            }

            upsertSecurity({
              ...blankSecurity(profile.symbol),
              ...existing,
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
              profileCheckedAt: todayIso(),
            });
          }

          // Symbols the feed could not place -- overwhelmingly delisted tickers
          // off closed positions. Recorded rather than skipped, so they settle
          // instead of being re-asked on every load forever, and given the best
          // type the ledger itself can vouch for: "Other" is precisely what
          // drops a closed holding out of a filtered chart.
          for (const symbol of chunk) {
            if (resolved.has(symbol)) continue;
            const existing = securityFor(symbol);
            if (existing?.assetClassSource === "manual") continue;
            if (existing && existing.profileCheckedAt !== null) continue;

            upsertSecurity({
              ...blankSecurity(symbol),
              ...existing,
              symbol,
              instrumentType:
                existing?.instrumentTypeSource === "manual"
                  ? existing.instrumentType
                  : inferInstrumentType(symbol, latest.transactions),
              instrumentTypeSource:
                existing?.instrumentTypeSource === "manual" ? "manual" : "auto",
              profileCheckedAt: todayIso(),
            });
          }
        }
      } catch {
        // A failed lookup leaves those symbols unclassified, which is exactly
        // where they were, and unrecorded, so a reload asks again. Whatever is
        // left in the queue is abandoned rather than retried: the symbols stay
        // in `requested`, so a flaky feed can't turn into a retry loop, and the
        // chunks that did land are already saved.
        queue.current = [];
      } finally {
        running.current = false;
        if (mounted.current) setLoading(false);
      }
    })();
  }, [key, hasHydrated, upsertSecurity]);

  return { profiles, loading };
}
