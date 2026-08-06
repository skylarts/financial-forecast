"use client";

import { useMemo, useState } from "react";
import { ASSET_CLASS_LABELS, type AssetClass } from "@/domain/portfolio";
import type { ClosedLot } from "@/engine/portfolio/lots";
import type { Holding } from "@/engine/portfolio/metrics";
import {
  gainForScope,
  inScope,
  returnForScope,
  rollUpBySymbol,
  type RollupScope,
  type SymbolRollup,
} from "@/engine/portfolio/bySymbol";
import { money, percent, price, shares, toneFor } from "@/lib/portfolio/format";
import { Segmented } from "@/components/ui/controls";
import { sortMarker, useSort, type SortAccessors } from "./useSort";

const HEAD = "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

const SCOPES = [
  { value: "both", label: "Everything" },
  { value: "positions", label: "Positions" },
  { value: "trades", label: "Trades" },
] as const;

const OUTCOMES = [
  { value: "all", label: "All" },
  { value: "winners", label: "Winners" },
  { value: "losers", label: "Losers" },
] as const;

type Outcome = (typeof OUTCOMES)[number]["value"];

type Column =
  | "symbol"
  | "quantity"
  | "price"
  | "value"
  | "weight"
  | "unrealized"
  | "realized"
  | "income"
  | "gain"
  | "return"
  | "trades";

const SCOPE_HINT: Record<RollupScope, string> = {
  both: "Unrealized, realized, and dividends together — the whole story on each name.",
  positions: "What you're still holding, and what it's done so far.",
  trades: "Round trips you've closed, and what they realized.",
};

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3" title={hint}>
      <div className="text-[10.5px] uppercase tracking-wide text-dim-2">{label}</div>
      <div className={`mt-1 text-[19px] font-semibold tabular-nums ${tone || "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

/** A compact ranked strip, so the extremes are readable without sorting. */
function Leaders({
  title,
  rows,
  scope,
  tone,
}: {
  title: string;
  rows: SymbolRollup[];
  scope: RollupScope;
  tone: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3">
      <div className="mb-2 text-[10.5px] uppercase tracking-wide text-dim-2">{title}</div>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.symbol} className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="font-semibold text-foreground">{row.symbol}</span>
            <span className="flex items-baseline gap-2 tabular-nums">
              <span className={tone}>{money(gainForScope(row, scope))}</span>
              <span className="w-14 text-right text-[11.5px] text-dim-2">
                {percent(returnForScope(row, scope))}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  column,
  align,
  sort,
  onToggle,
  title,
}: {
  label: string;
  column: Column;
  align: "left" | "right";
  sort: { key: Column; direction: "asc" | "desc" };
  onToggle: (column: Column) => void;
  title?: string;
}) {
  const alignClass = align === "left" ? "text-left" : "text-right";
  return (
    <th className={`${HEAD} ${alignClass}`} title={title}>
      <button
        type="button"
        onClick={() => onToggle(column)}
        className={`w-full ${alignClass} uppercase tracking-wide transition-colors hover:text-foreground ${
          sort.key === column ? "text-foreground" : ""
        }`}
      >
        {label}
        {sortMarker(sort, column)}
      </button>
    </th>
  );
}

/**
 * One row per stock, across every account and both halves of the ledger.
 *
 * The rest of the tracker answers "what do I hold, and where". This answers
 * "which of these names has actually made me money", which is a different
 * question and was previously only answerable by adding columns up by hand.
 */
export function BySymbolPanel({
  holdings,
  closedLots,
  onSelectSymbol,
}: {
  holdings: Holding[];
  closedLots: ClosedLot[];
  /** Jumps to the holdings view filtered to this ticker. */
  onSelectSymbol: (symbol: string) => void;
}) {
  const [scope, setScope] = useState<RollupScope>("both");
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [search, setSearch] = useState("");
  const [assetClassFilter, setAssetClassFilter] = useState<AssetClass | "all">("all");

  const all = useMemo(() => rollUpBySymbol(holdings, closedLots), [holdings, closedLots]);

  const rows = useMemo(() => {
    const query = search.trim().toUpperCase();
    return all.filter((row) => {
      if (!inScope(row, scope)) return false;
      if (query && !row.symbol.includes(query) && !row.name.toUpperCase().includes(query)) return false;
      if (assetClassFilter !== "all" && row.assetClass !== assetClassFilter) return false;
      const gain = gainForScope(row, scope);
      if (outcome === "winners" && gain <= 0) return false;
      if (outcome === "losers" && gain >= 0) return false;
      return true;
    });
  }, [all, scope, search, assetClassFilter, outcome]);

  const accessors = useMemo<SortAccessors<SymbolRollup, Column>>(
    () => ({
      symbol: (r) => r.symbol,
      quantity: (r) => r.quantity,
      price: (r) => r.price ?? Number.NaN,
      value: (r) => r.marketValue,
      weight: (r) => r.weight,
      unrealized: (r) => r.unrealizedGain,
      realized: (r) => r.realizedGain,
      income: (r) => r.income,
      gain: (r) => gainForScope(r, scope),
      return: (r) => returnForScope(r, scope) ?? Number.NaN,
      trades: (r) => r.tradeCount,
    }),
    [scope],
  );
  const { sort, toggle, apply } = useSort<SymbolRollup, Column>(accessors, "gain");
  const sorted = useMemo(() => apply(rows), [apply, rows]);

  const presentAssetClasses = useMemo(
    () => [...new Set(all.map((r) => r.assetClass))].sort(),
    [all],
  );

  // Ranked on the scope's own gain, so switching to Trades reshuffles these to
  // the best and worst round trips rather than leaving position figures behind.
  const ranked = useMemo(
    () => [...rows].sort((a, b) => gainForScope(b, scope) - gainForScope(a, scope)),
    [rows, scope],
  );
  const winners = ranked.filter((r) => gainForScope(r, scope) > 0).slice(0, 5);
  const losers = ranked
    .filter((r) => gainForScope(r, scope) < 0)
    .slice(-5)
    .reverse();

  const totalGain = rows.reduce((sum, r) => sum + gainForScope(r, scope), 0);
  const winnerCount = rows.filter((r) => gainForScope(r, scope) > 0).length;
  const loserCount = rows.filter((r) => gainForScope(r, scope) < 0).length;

  const filtersActive = search !== "" || assetClassFilter !== "all" || outcome !== "all";

  if (all.length === 0) {
    return (
      <p className="p-8 text-center text-[13px] text-dim">
        Nothing to rank yet. Import a transaction history or add a buy.
      </p>
    );
  }

  return (
    <div className="p-5">
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={scope === "trades" ? "Realized" : scope === "positions" ? "Unrealized" : "Total gain"}
          value={money(totalGain)}
          tone={toneFor(totalGain)}
          hint={SCOPE_HINT[scope]}
        />
        <Stat
          label="Winners / losers"
          value={`${winnerCount} / ${loserCount}`}
          hint="How many names are up versus down, on this scope."
        />
        <Leaders title="Best" rows={winners} scope={scope} tone="text-positive" />
        <Leaders title="Worst" rows={losers} scope={scope} tone="text-negative" />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          options={SCOPES}
          value={scope}
          onChange={setScope}
          size="sm"
          ariaLabel="Which half of the ledger to rank"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol or name"
          className="w-52 rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
        />
        {presentAssetClasses.length > 1 && (
          <select
            value={assetClassFilter}
            onChange={(e) => setAssetClassFilter(e.target.value as AssetClass | "all")}
            className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground"
          >
            <option value="all">All asset classes</option>
            {presentAssetClasses.map((cls) => (
              <option key={cls} value={cls}>
                {ASSET_CLASS_LABELS[cls]}
              </option>
            ))}
          </select>
        )}
        <Segmented
          options={OUTCOMES}
          value={outcome}
          onChange={setOutcome}
          size="sm"
          ariaLabel="Filter by outcome"
        />
        <span className="text-[11.5px] text-dim-2">
          {rows.length} of {all.length} names
          {filtersActive && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setAssetClassFilter("all");
                setOutcome("all");
              }}
              className="ml-2 underline hover:text-foreground"
            >
              Clear filters
            </button>
          )}
        </span>
      </div>

      {sorted.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">No names match those filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="max-h-[70vh] overflow-auto rounded-md border border-border-soft">
          <table className="w-full border-collapse">
            <thead>
              <tr className="sticky top-0 z-10 border-b border-border bg-panel">
                <SortHeader label="Stock" column="symbol" align="left" sort={sort} onToggle={toggle} />
                <SortHeader label="Shares" column="quantity" align="right" sort={sort} onToggle={toggle} />
                <SortHeader label="Price" column="price" align="right" sort={sort} onToggle={toggle} />
                <SortHeader label="Value" column="value" align="right" sort={sort} onToggle={toggle} />
                <SortHeader label="Weight" column="weight" align="right" sort={sort} onToggle={toggle} />
                <SortHeader label="Unrealized" column="unrealized" align="right" sort={sort} onToggle={toggle} />
                <SortHeader
                  label="Realized"
                  column="realized"
                  align="right"
                  sort={sort}
                  onToggle={toggle}
                  title="Gains already booked on closed lots."
                />
                <SortHeader label="Dividends" column="income" align="right" sort={sort} onToggle={toggle} />
                <SortHeader
                  label="Trades"
                  column="trades"
                  align="right"
                  sort={sort}
                  onToggle={toggle}
                  title="Closed round trips, and how many of them made money."
                />
                <SortHeader
                  label="Gain"
                  column="gain"
                  align="right"
                  sort={sort}
                  onToggle={toggle}
                  title={SCOPE_HINT[scope]}
                />
                <SortHeader label="Return" column="return" align="right" sort={sort} onToggle={toggle} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const gain = gainForScope(row, scope);
                return (
                  <tr
                    key={row.symbol}
                    onClick={() => onSelectSymbol(row.symbol)}
                    title={`Show ${row.symbol} in Holdings`}
                    className="cursor-pointer border-b border-border-soft transition-colors hover:bg-panel-2"
                  >
                    <td className={`${CELL} text-left`}>
                      <span className="font-semibold text-foreground">{row.symbol}</span>
                      {!row.isOpen && (
                        <span
                          title="Nothing held any more — everything here is realized."
                          className="ml-1.5 rounded-sm border border-border px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-dim-2"
                        >
                          Closed
                        </span>
                      )}
                      {row.accountCount > 1 && (
                        <span
                          title={`Held across ${row.accountCount} accounts, combined here.`}
                          className="ml-1.5 text-[11px] text-dim-2"
                        >
                          ×{row.accountCount}
                        </span>
                      )}
                      {row.name !== row.symbol && (
                        <span className="ml-2 text-[11.5px] text-dim-2">{row.name}</span>
                      )}
                    </td>
                    <td className={`${CELL} text-right text-dim`}>
                      {row.isOpen ? shares(row.quantity) : "—"}
                    </td>
                    <td className={`${CELL} text-right text-dim`}>
                      {row.price === null ? "—" : price(row.price)}
                    </td>
                    <td className={`${CELL} text-right font-semibold text-foreground`}>
                      {row.isOpen ? money(row.marketValue) : "—"}
                    </td>
                    <td className={`${CELL} text-right text-dim`}>
                      {row.isOpen ? `${(row.weight * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className={`${CELL} text-right ${toneFor(row.unrealizedGain)}`}>
                      {row.isOpen ? money(row.unrealizedGain) : "—"}
                    </td>
                    <td className={`${CELL} text-right ${toneFor(row.realizedGain)}`}>
                      {row.tradeCount > 0 ? money(row.realizedGain) : "—"}
                    </td>
                    <td className={`${CELL} text-right text-dim`}>
                      {row.income !== 0 ? money(row.income) : "—"}
                    </td>
                    <td className={`${CELL} text-right text-dim`}>
                      {row.tradeCount === 0 ? (
                        "—"
                      ) : (
                        <span
                          title={`${row.winCount} of ${row.tradeCount} made money${
                            row.avgHoldDays !== null
                              ? `, held ${Math.round(row.avgHoldDays)} days on average`
                              : ""
                          }.`}
                        >
                          {row.winCount}/{row.tradeCount}
                        </span>
                      )}
                    </td>
                    <td className={`${CELL} text-right font-semibold ${toneFor(gain)}`}>{money(gain)}</td>
                    <td className={`${CELL} text-right ${toneFor(gain)}`}>
                      {percent(returnForScope(row, scope))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="sticky bottom-0 z-10 border-t border-border bg-panel font-semibold">
                <td className={`${CELL} text-left text-foreground`}>Total</td>
                <td className={CELL}></td>
                <td className={CELL}></td>
                <td className={`${CELL} text-right text-foreground`}>
                  {money(rows.reduce((s, r) => s + (r.isOpen ? r.marketValue : 0), 0))}
                </td>
                <td className={`${CELL} text-right text-dim`}>
                  {(rows.reduce((s, r) => s + (r.isOpen ? r.weight : 0), 0) * 100).toFixed(1)}%
                </td>
                <td className={`${CELL} text-right ${toneFor(rows.reduce((s, r) => s + r.unrealizedGain, 0))}`}>
                  {money(rows.reduce((s, r) => s + r.unrealizedGain, 0))}
                </td>
                <td className={`${CELL} text-right ${toneFor(rows.reduce((s, r) => s + r.realizedGain, 0))}`}>
                  {money(rows.reduce((s, r) => s + r.realizedGain, 0))}
                </td>
                <td className={`${CELL} text-right text-dim`}>{money(rows.reduce((s, r) => s + r.income, 0))}</td>
                <td className={CELL}></td>
                <td className={`${CELL} text-right ${toneFor(totalGain)}`}>{money(totalGain)}</td>
                <td className={CELL}></td>
              </tr>
            </tfoot>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
