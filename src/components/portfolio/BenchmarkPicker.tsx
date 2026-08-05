"use client";

import { useEffect, useRef, useState } from "react";

interface SymbolMatch {
  symbol: string;
  name: string;
  exchange?: string;
}

/**
 * Adds a comparison ticker by search.
 *
 * Deliberately lighter than the transaction entry field, which also resolves
 * option chains and confirms contracts before accepting them. A benchmark just
 * needs a symbol the price feed can answer for, and making the user go through
 * contract verification to add the S&P would be an odd tax.
 */
export function BenchmarkPicker({
  onAdd,
  disabled,
  disabledReason,
}: {
  onAdd: (symbol: string) => void;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; matches: SymbolMatch[] } | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  // A single character matches most of the market, so the search waits for the
  // second one -- which also means a one-letter query has no pending request to
  // report as loading.
  const searchable = trimmed.length >= 2;
  const matches = result?.query === trimmed ? result.matches : [];
  const loading = searchable && result?.query !== trimmed;

  useEffect(() => {
    if (!searchable) return;

    // Debounced so a fast typist doesn't fire a request per keystroke at a feed
    // that throttles bursts.
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/symbols/search?q=${encodeURIComponent(trimmed)}`)
        .then((r) => (r.ok ? r.json() : { matches: [] }))
        .then((body: { matches?: SymbolMatch[] }) => {
          if (cancelled) return;
          setResult({ query: trimmed, matches: body.matches ?? [] });
          setOpen(true);
        })
        .catch(() => {
          if (!cancelled) setResult({ query: trimmed, matches: [] });
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, searchable]);

  useEffect(() => {
    const onClickAway = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, []);

  const choose = (symbol: string) => {
    onAdd(symbol.toUpperCase());
    setQuery("");
    setResult(null);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        value={query}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => matches.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          // Enter takes the top match, or the raw text when nothing matched --
          // a ticker you already know shouldn't need the list to agree first.
          if (e.key !== "Enter") return;
          e.preventDefault();
          const pick = matches[0]?.symbol ?? query.trim();
          if (pick) choose(pick);
        }}
        placeholder={disabled ? "5 comparisons is the limit" : "Compare against… (e.g. SPY)"}
        className="w-56 rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent disabled:opacity-50"
      />
      {open && (matches.length > 0 || loading) && (
        <div className="absolute z-20 mt-1 max-h-64 w-72 overflow-y-auto rounded-md border border-border bg-panel shadow-lg">
          {loading && matches.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-dim">Searching…</div>
          ) : (
            matches.map((match) => (
              <button
                key={match.symbol}
                type="button"
                onClick={() => choose(match.symbol)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-panel-2"
              >
                <span className="text-[12.5px] font-semibold text-foreground">{match.symbol}</span>
                <span className="truncate text-[11.5px] text-dim-2">{match.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
