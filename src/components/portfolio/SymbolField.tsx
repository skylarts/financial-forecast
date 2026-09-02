"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ASSET_CLASS_LABELS,
  isOptionSymbol,
  underlyingSymbol,
  type AssetClass,
} from "@/domain/portfolio";
import { price as fmtPrice, shortDate } from "@/lib/portfolio/format";
import { Btn, Segmented } from "@/components/ui/controls";

/**
 * A symbol input that confirms what was typed.
 *
 * A mistyped ticker is the quietest error in the app: the holding appears, gets
 * valued at cost basis because nothing prices it, and nothing on screen says the
 * symbol was never real. The fix has to happen at entry, which is the only
 * moment the user still remembers what they meant.
 */

interface SymbolMatch {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  assetClass: AssetClass;
  basis: string;
}

interface Verdict {
  symbol: string;
  kind: "ticker" | "contract";
  label: string;
  status: "ok" | "unlisted" | "expired" | "unknown" | "unavailable";
  name: string;
  assetClass: AssetClass | null;
  basis: string;
  price: number | null;
  priceDate: string | null;
}

interface OptionQuote {
  symbol: string;
  strike: number;
  right: "call" | "put";
  lastPrice: number | null;
  openInterest: number;
}

interface OptionChain {
  underlying: string;
  expiries: string[];
  expiry: string;
  contracts: OptionQuote[];
}

const INPUT =
  "rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent";

const DEBOUNCE_MS = 300;

/** Ignores every response but the newest, so a slow reply can't overwrite a fast one. */
function useLatest() {
  const seq = useRef(0);
  return {
    next: () => ++seq.current,
    isCurrent: (ticket: number) => ticket === seq.current,
  };
}

/**
 * Runs `fn` on the next microtask.
 *
 * setState belongs in a callback that fires later (a subscription, a fetch
 * response), not synchronously in an effect body -- doing it synchronously
 * forces an extra render before the browser paints. Every setState below that
 * isn't already inside a fetch callback goes through this so the effect body
 * itself never calls one directly.
 */
function defer(fn: () => void): void {
  void Promise.resolve().then(fn);
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/* -------------------------------------------------------------------------- */

function VerdictLine({ verdict, onBrowse }: { verdict: Verdict; onBrowse: () => void }) {
  const classLabel = verdict.assetClass ? ASSET_CLASS_LABELS[verdict.assetClass] : null;

  if (verdict.status === "unknown") {
    return (
      <p className="text-[11.5px] text-negative">
        ✕ The feed doesn&apos;t recognise {verdict.symbol}. Check the spelling, or{" "}
        <button type="button" onClick={onBrowse} className="underline hover:text-foreground">
          look up a contract
        </button>
        .
      </p>
    );
  }

  if (verdict.status === "unlisted") {
    return (
      <p className="text-[11.5px] text-negative">
        ✕ {verdict.label} isn&apos;t a listed contract — the expiry or strike is off.{" "}
        <button type="button" onClick={onBrowse} className="underline hover:text-foreground">
          Browse what&apos;s listed
        </button>
        .
      </p>
    );
  }

  if (verdict.status === "expired") {
    return (
      <p className="text-[11.5px] text-accent">
        ⏱ {verdict.label} — expired, so nothing prices it. Right for a closed position; if this
        one is still open, the expiry is wrong.
      </p>
    );
  }

  if (verdict.status === "unavailable") {
    return (
      <p className="text-[11.5px] text-dim">
        ✓ {verdict.label} — recognised, but the feed has no price right now.
      </p>
    );
  }

  return (
    <p className="text-[11.5px] text-positive">
      ✓ {verdict.label}
      {verdict.price !== null && (
        <span className="text-dim">
          {" · "}
          {fmtPrice(verdict.price)}
          {verdict.priceDate ? ` on ${shortDate(verdict.priceDate)}` : ""}
        </span>
      )}
      {classLabel && <span className="text-dim-2">{` · ${classLabel}`}</span>}
    </p>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Picks a contract off the underlying's actual listing.
 *
 * Expiries and strikes are set by the exchange, and a plausible-looking pair the
 * exchange never listed prices at nothing and looks exactly like a typo. Showing
 * the real ones is what turns "I think this is the symbol" into a confirmation.
 */
function ContractPicker({
  underlying,
  onPick,
  onClose,
}: {
  underlying: string;
  onPick: (symbol: string) => void;
  onClose: () => void;
}) {
  const [root, setRoot] = useState(underlying);
  const [expiry, setExpiry] = useState("");
  const [right, setRight] = useState<"call" | "put">("call");
  const [chain, setChain] = useState<OptionChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useLatest();

  const debouncedRoot = useDebounced(root.trim().toUpperCase(), DEBOUNCE_MS);

  useEffect(() => {
    if (!debouncedRoot) return;
    const ticket = latest.next();
    defer(() => setLoading(true));
    const params = new URLSearchParams({ underlying: debouncedRoot });
    if (expiry) params.set("expiry", expiry);

    void fetch(`/api/symbols/options?${params}`)
      .then((r) => r.json() as Promise<{ chain: OptionChain | null }>)
      .then((body) => {
        if (!latest.isCurrent(ticket)) return;
        setChain(body.chain);
        setFailed(body.chain === null);
        // The feed picks the nearest expiry when none was asked for; adopt it so
        // the dropdown shows what's actually on screen.
        if (body.chain && !expiry) setExpiry(body.chain.expiry);
      })
      .catch(() => {
        if (latest.isCurrent(ticket)) setFailed(true);
      })
      .finally(() => {
        if (latest.isCurrent(ticket)) setLoading(false);
      });
    // `latest` is a stable ref wrapper; re-running on it would defeat the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedRoot, expiry]);

  const strikes = useMemo(
    () => (chain?.contracts ?? []).filter((c) => c.right === right),
    [chain, right],
  );

  return (
    <div className="mt-2 rounded-md border border-border bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Underlying</span>
          <input
            value={root}
            onChange={(e) => {
              setRoot(e.target.value);
              setExpiry("");
            }}
            placeholder="SPY"
            className={`${INPUT} w-24`}
          />
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Expiry</span>
          <select
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            disabled={!chain}
            className={`${INPUT} w-36 disabled:opacity-40`}
          >
            {chain?.expiries.length ? (
              chain.expiries.map((date) => (
                <option key={date} value={date}>
                  {shortDate(date)}
                </option>
              ))
            ) : (
              <option value="">—</option>
            )}
          </select>
        </label>
        <div className="pb-0.5">
          <Segmented
            options={[
              { value: "call", label: "Calls" },
              { value: "put", label: "Puts" },
            ] as const}
            value={right}
            onChange={setRight}
            size="sm"
            ariaLabel="Calls or puts"
          />
        </div>
        <div className="ml-auto pb-0.5">
          <Btn onClick={onClose}>Done</Btn>
        </div>
      </div>

      {loading && <p className="text-[11.5px] text-dim">Loading contracts…</p>}

      {!loading && failed && (
        <p className="text-[11.5px] text-dim">
          Couldn&apos;t read the listing for {debouncedRoot}. Type the contract instead — any of
          &ldquo;SPY 01/15/2027 600 C&rdquo;, &ldquo;SPY270115C600&rdquo;, or the full
          &ldquo;SPY270115C00600000&rdquo; works.
        </p>
      )}

      {!loading && !failed && strikes.length === 0 && (
        <p className="text-[11.5px] text-dim">No {right}s listed for that expiry.</p>
      )}

      {!loading && strikes.length > 0 && (
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                {["Strike", "Last", "Open interest", ""].map((h, i) => (
                  <th
                    key={h || i}
                    className={`px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-dim-2 ${
                      i === 0 ? "text-left" : "text-right"
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {strikes.map((contract) => (
                <tr key={contract.symbol} className="border-b border-border-soft hover:bg-panel-2">
                  <td className="px-2 py-1 text-left text-[12px] font-semibold tabular-nums text-foreground">
                    {contract.strike}
                  </td>
                  <td className="px-2 py-1 text-right text-[12px] tabular-nums text-dim">
                    {contract.lastPrice === null ? "—" : fmtPrice(contract.lastPrice)}
                  </td>
                  <td className="px-2 py-1 text-right text-[12px] tabular-nums text-dim-2">
                    {contract.openInterest.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => onPick(contract.symbol)}
                      className="text-[11.5px] text-accent underline hover:text-foreground"
                    >
                      Use
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function SymbolField({
  value,
  onChange,
  label = "Symbol",
}: {
  value: string;
  onChange: (symbol: string) => void;
  label?: string;
}) {
  const [matches, setMatches] = useState<SymbolMatch[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checking, setChecking] = useState(false);
  const [showMatches, setShowMatches] = useState(false);
  const [picking, setPicking] = useState(false);

  const debounced = useDebounced(value.trim(), DEBOUNCE_MS);
  const searchSeq = useLatest();
  const verifySeq = useLatest();

  // A contract has no name to search for, so suggestions would only ever be
  // noise next to one -- the picker is the right tool there.
  const looksLikeContract = isOptionSymbol(debounced);

  useEffect(() => {
    if (!debounced || looksLikeContract || debounced.length < 2) {
      defer(() => setMatches([]));
      return;
    }
    const ticket = searchSeq.next();
    void fetch(`/api/symbols/search?q=${encodeURIComponent(debounced)}`)
      .then((r) => r.json() as Promise<{ matches: SymbolMatch[] }>)
      .then((body) => {
        if (searchSeq.isCurrent(ticket)) setMatches(body.matches ?? []);
      })
      .catch(() => {
        if (searchSeq.isCurrent(ticket)) setMatches([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, looksLikeContract]);

  useEffect(() => {
    if (!debounced) {
      defer(() => {
        setVerdict(null);
        setChecking(false);
      });
      return;
    }
    const ticket = verifySeq.next();
    defer(() => setChecking(true));
    void fetch(`/api/symbols/verify?symbol=${encodeURIComponent(debounced)}`)
      .then((r) => r.json() as Promise<{ verdict: Verdict | null }>)
      .then((body) => {
        if (verifySeq.isCurrent(ticket)) setVerdict(body.verdict);
      })
      .catch(() => {
        if (verifySeq.isCurrent(ticket)) setVerdict(null);
      })
      .finally(() => {
        if (verifySeq.isCurrent(ticket)) setChecking(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const choose = (symbol: string) => {
    onChange(symbol);
    setShowMatches(false);
    setPicking(false);
  };

  const suggestionsVisible = showMatches && matches.length > 0 && !picking;

  return (
    <div className="col-span-2 w-full min-w-0 sm:col-auto sm:min-w-[16rem] sm:flex-1">
      <label className="block text-[11.5px] text-dim-2">
        <span className="mb-0.5 block">{label}</span>
        <div className="relative">
          <input
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setShowMatches(true);
            }}
            onFocus={() => setShowMatches(true)}
            // A click on a suggestion has to land before the list closes, and
            // blur fires first -- hence the delay rather than an immediate close.
            onBlur={() => setTimeout(() => setShowMatches(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowMatches(false);
              if (e.key === "Enter" && matches.length > 0 && suggestionsVisible) {
                e.preventDefault();
                choose(matches[0].symbol);
              }
            }}
            placeholder="SPY, or SPY 01/15/2027 600 C"
            autoComplete="off"
            spellCheck={false}
            className={`${INPUT} w-full`}
          />

          {suggestionsVisible && (
            <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-panel shadow-lg">
              {matches.map((match) => (
                <li key={match.symbol}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(match.symbol)}
                    className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-panel-2"
                  >
                    <span className="text-[12.5px] font-semibold text-foreground">{match.symbol}</span>
                    <span className="flex-1 truncate text-[11.5px] text-dim">{match.name}</span>
                    <span className="shrink-0 text-[10.5px] text-dim-2">
                      {[match.type, match.exchange].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </label>

      <div className="mt-1 flex items-baseline gap-2">
        {checking && <span className="text-[11.5px] text-dim-2">Checking…</span>}
        {!checking && verdict && (
          <VerdictLine verdict={verdict} onBrowse={() => setPicking(true)} />
        )}
        {!checking && !verdict && !value.trim() && (
          <span className="text-[11.5px] text-dim-2">
            Start typing a ticker, or{" "}
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="underline hover:text-foreground"
            >
              find an option contract
            </button>
            .
          </span>
        )}
        {!picking && value.trim() !== "" && (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="shrink-0 text-[11.5px] text-dim-2 underline hover:text-foreground"
          >
            Options…
          </button>
        )}
      </div>

      {picking && (
        <ContractPicker
          underlying={underlyingSymbol(value.trim()) || ""}
          onPick={choose}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
