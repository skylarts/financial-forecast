"use client";

import { Fragment, useMemo } from "react";
import { ASSET_CLASS_LABELS } from "@/domain/portfolio";
import type { Holding } from "@/engine/portfolio/metrics";
import { money, percent, price, shares, shortDate, toneFor } from "@/lib/portfolio/format";
import { sortMarker, useSort, type SortAccessors } from "./useSort";

export type HoldingGrouping = "none" | "account" | "assetClass" | "side";

type Column =
  | "symbol"
  | "account"
  | "quantity"
  | "avgCost"
  | "price"
  | "value"
  | "weight"
  | "unrealized"
  | "return"
  | "irr";

const HEAD = "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

function SortHeader({
  label,
  column,
  align,
  sort,
  onToggle,
}: {
  label: string;
  column: Column;
  align: "left" | "right";
  sort: { key: Column; direction: "asc" | "desc" };
  onToggle: (column: Column) => void;
}) {
  const active = sort.key === column;
  // Written out rather than interpolated: Tailwind only ships classes it can
  // see as complete strings in the source.
  const alignClass = align === "left" ? "text-left" : "text-right";
  return (
    <th className={`${HEAD} ${alignClass}`}>
      <button
        type="button"
        onClick={() => onToggle(column)}
        title={`Sort by ${label.toLowerCase()}`}
        className={`w-full ${alignClass} uppercase tracking-wide transition-colors hover:text-foreground ${
          active ? "text-foreground" : ""
        }`}
      >
        {label}
        {sortMarker(sort, column)}
      </button>
    </th>
  );
}

/** Subtotal strip shown above each group when grouping is on. */
function GroupRow({ label, value, span }: { label: string; value: number; span: number }) {
  return (
    <tr className="border-b border-border bg-panel-2">
      <td colSpan={span} className="px-3 py-1.5 text-[11.5px] font-semibold text-dim">
        {label}
        <span className="ml-2 font-normal tabular-nums text-dim-2">{money(value)}</span>
      </td>
    </tr>
  );
}

export function HoldingsTable({
  holdings,
  accountNames,
  showAccount,
  grouping,
  onSelect,
}: {
  holdings: Holding[];
  accountNames: Map<string, string>;
  showAccount: boolean;
  grouping: HoldingGrouping;
  onSelect: (holding: Holding) => void;
}) {
  const accessors = useMemo<SortAccessors<Holding, Column>>(
    () => ({
      symbol: (h) => h.symbol,
      account: (h) => accountNames.get(h.accountId) ?? "",
      quantity: (h) => h.quantity,
      avgCost: (h) => h.avgCostPerShare,
      price: (h) => h.price ?? Number.NaN,
      value: (h) => h.marketValue,
      weight: (h) => h.weight,
      unrealized: (h) => h.unrealizedGain,
      return: (h) => h.unrealizedGainPct ?? Number.NaN,
      irr: (h) => h.irr ?? Number.NaN,
    }),
    [accountNames],
  );

  const { sort, toggle, apply } = useSort<Holding, Column>(accessors, "value");
  const sorted = useMemo(() => apply(holdings), [apply, holdings]);

  const groups = useMemo(() => {
    if (grouping === "none") return [{ label: "", rows: sorted }];
    const labelFor = (h: Holding) =>
      grouping === "account"
        ? accountNames.get(h.accountId) ?? "Unknown account"
        : grouping === "assetClass"
          ? ASSET_CLASS_LABELS[h.assetClass]
          : h.side === "short"
            ? "Short positions"
            : "Long positions";

    const map = new Map<string, Holding[]>();
    for (const holding of sorted) {
      const label = labelFor(holding);
      const bucket = map.get(label);
      if (bucket) bucket.push(holding);
      else map.set(label, [holding]);
    }
    // Groups are ordered by size so the money leads, matching the row sort.
    return [...map.entries()]
      .map(([label, rows]) => ({ label, rows }))
      .sort(
        (a, b) =>
          b.rows.reduce((s, h) => s + h.marketValue, 0) - a.rows.reduce((s, h) => s + h.marketValue, 0),
      );
  }, [sorted, grouping, accountNames]);

  if (holdings.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-[13px] text-dim">
        No open positions match. Clear the filters, import a transaction history, or add a buy.
      </p>
    );
  }

  const columnCount = showAccount ? 10 : 9;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <SortHeader label="Holding" column="symbol" align="left" sort={sort} onToggle={toggle} />
            {showAccount && (
              <SortHeader label="Account" column="account" align="left" sort={sort} onToggle={toggle} />
            )}
            <SortHeader label="Shares" column="quantity" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Avg cost" column="avgCost" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Price" column="price" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Value" column="value" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Weight" column="weight" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Unrealized" column="unrealized" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Return" column="return" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Annualized" column="irr" align="right" sort={sort} onToggle={toggle} />
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.label || "all"}>
              {grouping !== "none" && (
                <GroupRow
                  label={group.label}
                  value={group.rows.reduce((sum, h) => sum + h.marketValue, 0)}
                  span={columnCount}
                />
              )}
              {group.rows.map((holding) => (
                <tr
                  key={holding.key}
                  onClick={() => onSelect(holding)}
                  className="cursor-pointer border-b border-border-soft transition-colors hover:bg-panel-2"
                >
                  <td className={`${CELL} text-left`}>
                    <span className="font-semibold text-foreground">{holding.symbol}</span>
                    {holding.side === "short" && (
                      <span
                        title="Short position — shares owed, valued as a liability"
                        className="ml-1.5 rounded-sm border border-negative px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-negative"
                      >
                        Short
                      </span>
                    )}
                    {holding.name !== holding.symbol && (
                      <span className="ml-2 text-[11.5px] text-dim-2">{holding.name}</span>
                    )}
                  </td>
                  {showAccount && (
                    <td className={`${CELL} text-left text-dim`}>
                      {accountNames.get(holding.accountId) ?? "—"}
                    </td>
                  )}
                  <td className={`${CELL} text-right text-dim`}>
                    {holding.side === "short" ? `(${shares(holding.quantity)})` : shares(holding.quantity)}
                  </td>
                  <td
                    className={`${CELL} text-right text-dim`}
                    title={holding.side === "short" ? "Average proceeds per share shorted" : undefined}
                  >
                    {price(holding.avgCostPerShare)}
                  </td>
                  <td className={`${CELL} text-right`}>
                    {holding.price === null ? (
                      <span className="text-dim-2" title="No quote available — valued at cost basis.">
                        no quote
                      </span>
                    ) : (
                      <span
                        className="text-foreground"
                        title={holding.priceDate ? `As of ${shortDate(holding.priceDate)}` : undefined}
                      >
                        {price(holding.price)}
                      </span>
                    )}
                  </td>
                  <td className={`${CELL} text-right font-semibold text-foreground`}>
                    {money(holding.marketValue)}
                  </td>
                  <td className={`${CELL} text-right text-dim`}>{(holding.weight * 100).toFixed(1)}%</td>
                  <td className={`${CELL} text-right ${toneFor(holding.unrealizedGain)}`}>
                    {money(holding.unrealizedGain)}
                  </td>
                  <td className={`${CELL} text-right ${toneFor(holding.unrealizedGain)}`}>
                    {percent(holding.unrealizedGainPct)}
                  </td>
                  <td className={`${CELL} text-right ${toneFor(holding.irr ?? 0)}`}>
                    {percent(holding.irr)}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
