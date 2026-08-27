"use client";

import { Fragment, useMemo } from "react";
import { ASSET_CLASS_LABELS } from "@/domain/portfolio";
import { explodeExposures, type Holding } from "@/engine/portfolio/metrics";
import { money, percent, price, shares, shortDate, toneFor } from "@/lib/portfolio/format";
import { sortMarker, useSort, type SortAccessors } from "./useSort";
import { buildGroups, GroupHeaderRow, GroupToggles, useCollapsedGroups, type Group } from "./grouping";
import { UNTAGGED } from "./filters";

export type HoldingGrouping = "none" | "account" | "assetClass" | "theme" | "side";

/** A row as actually rendered. Grouping by class or theme can turn one
 *  holding into several of these -- `source` is always the real, whole
 *  holding behind the row, which is what a click should open. */
type Row = Holding & { source: Holding; sliceNote?: string };

function toRow(holding: Holding): Row {
  return { ...holding, source: holding };
}

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

interface GroupTotals {
  marketValue: number;
  costBasis: number;
  weight: number;
  unrealizedGain: number;
  /** Null when the group has no basis to measure against, same as a single row. */
  returnPct: number | null;
}

/**
 * What a group's subtotal row reports.
 *
 * Return is the group's own gain over its own basis, not an average of the
 * member percentages -- averaging would let a tiny position's 300% swamp the
 * figure for a group whose money is overwhelmingly somewhere else.
 */
function totalsFor(rows: readonly Holding[]): GroupTotals {
  const marketValue = rows.reduce((sum, h) => sum + h.marketValue, 0);
  const costBasis = rows.reduce((sum, h) => sum + h.costBasis, 0);
  const unrealizedGain = rows.reduce((sum, h) => sum + h.unrealizedGain, 0);
  return {
    marketValue,
    costBasis,
    weight: rows.reduce((sum, h) => sum + h.weight, 0),
    unrealizedGain,
    returnPct: costBasis > 0 ? unrealizedGain / costBasis : null,
  };
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
  // Sorted before any grouping-driven explosion, so "sort by value" orders by
  // each holding's whole position, not by whatever fraction of it a class
  // split happens to land in first.
  const sorted = useMemo(() => apply(holdings), [apply, holdings]);

  const groups = useMemo((): Group<Row>[] => {
    if (grouping === "none") return [{ key: "", label: "", rows: sorted.map(toRow) }];

    if (grouping === "assetClass") {
      // A single-class holding explodes into one row identical to itself; a
      // fund like VT explodes into one row per class it spans, each carrying
      // only its own slice of the value -- see `explodeExposures`.
      const rows: Row[] = explodeExposures(sorted).map((r) => ({
        ...r,
        source: r.source,
        sliceNote: r.exposureCount > 1 ? `${Math.round(r.exposureWeight * 100)}% of position` : undefined,
      }));
      return buildGroups(rows, (r) => ASSET_CLASS_LABELS[r.assetClass]);
    }

    if (grouping === "theme") {
      // Unlike a class split, a theme tag doesn't divide the holding's value
      // -- a position tagged both "Core" and "AI" shows its full value under
      // each, which is why the grand total below is computed off the
      // unexploded list rather than off these groups.
      const buckets = new Map<string, Row[]>();
      for (const holding of sorted) {
        const tags = holding.themes.length > 0 ? holding.themes : [UNTAGGED];
        for (const tag of tags) {
          const row: Row = { ...holding, key: tags.length > 1 ? `${holding.key}::${tag}` : holding.key, source: holding };
          const bucket = buckets.get(tag);
          if (bucket) bucket.push(row);
          else buckets.set(tag, [row]);
        }
      }
      return [...buckets.entries()].map(([label, rows]) => ({ key: label, label, rows }));
    }

    const labelFor = (h: Holding) =>
      grouping === "account"
        ? accountNames.get(h.accountId) ?? "Unknown account"
        : h.side === "short"
          ? "Short positions"
          : "Long positions";

    return buildGroups(sorted.map(toRow), labelFor);
  }, [sorted, grouping, accountNames]);

  const collapse = useCollapsedGroups(grouping);
  const groupKeys = useMemo(() => groups.map((g) => g.key), [groups]);

  if (holdings.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-[13px] text-dim">
        No open positions match. Clear the filters, import a transaction history, or add a buy.
      </p>
    );
  }

  // Everything left of Value: the label spans them because none of shares, avg
  // cost, or price means anything summed across different securities.
  const labelSpan = showAccount ? 5 : 4;
  // Totals over every visible row regardless of group collapse -- collapsing a
  // group hides its rows, not its money.
  const grandTotals = totalsFor(sorted);

  return (
    <div className="overflow-x-auto">
      {grouping !== "none" && (
        <div className="mb-1.5 flex justify-end">
          <GroupToggles groupKeys={groupKeys} collapse={collapse} />
        </div>
      )}
      <div className="max-h-[70vh] overflow-auto rounded-md border border-border-soft">
      <table className="w-full border-collapse">
        <thead>
          <tr className="sticky top-0 z-10 border-b border-border bg-panel">
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
          {groups.map((group) => {
            const totals = totalsFor(group.rows);
            const collapsed = grouping !== "none" && collapse.isCollapsed(group.key);
            return (
            <Fragment key={group.key || "all"}>
              {grouping !== "none" && (
                <GroupHeaderRow
                  label={group.label}
                  count={group.rows.length}
                  collapsed={collapsed}
                  onToggle={() => collapse.toggle(group.key)}
                  labelSpan={labelSpan}
                  cells={[
                    <span key="value" className="text-foreground">
                      {money(totals.marketValue)}
                    </span>,
                    <span key="weight" className="text-dim">
                      {(totals.weight * 100).toFixed(1)}%
                    </span>,
                    <span key="unrealized" className={toneFor(totals.unrealizedGain)}>
                      {money(totals.unrealizedGain)}
                    </span>,
                    <span key="return" className={toneFor(totals.unrealizedGain)}>
                      {percent(totals.returnPct)}
                    </span>,
                    null,
                  ]}
                />
              )}
              {!collapsed &&
                group.rows.map((holding) => {
                  // Cash has no lots, no trades, and no chart -- opening a
                  // detail panel on it would show a page of blanks.
                  const isCash = holding.kind === "cash";
                  return (
                <tr
                  key={holding.key}
                  onClick={isCash ? undefined : () => onSelect(holding.source)}
                  className={`border-b border-border-soft transition-colors hover:bg-panel-2 ${
                    isCash ? "" : "cursor-pointer"
                  }`}
                >
                  <td className={`${CELL} text-left`}>
                    <span className="font-semibold text-foreground">
                      {isCash ? "Cash" : holding.symbol}
                    </span>
                    {holding.sliceNote && (
                      <span className="ml-1.5 text-[10.5px] text-dim-2">({holding.sliceNote})</span>
                    )}
                    {isCash && (
                      <span
                        title="Uninvested cash. Counted in your allocation, but it has no basis and no return."
                        className="ml-1.5 rounded-sm border border-border px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-dim-2"
                      >
                        Uninvested
                      </span>
                    )}
                    {holding.side === "short" && (
                      <span
                        title="Short position — shares owed, valued as a liability"
                        className="ml-1.5 rounded-sm border border-negative px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-negative"
                      >
                        Short
                      </span>
                    )}
                    {!isCash && holding.name !== holding.symbol && (
                      <span className="ml-2 text-[11.5px] text-dim-2">{holding.name}</span>
                    )}
                  </td>
                  {showAccount && (
                    <td className={`${CELL} text-left text-dim`}>
                      {accountNames.get(holding.accountId) ?? "—"}
                    </td>
                  )}
                  <td className={`${CELL} text-right text-dim`}>
                    {isCash
                      ? "—"
                      : holding.side === "short"
                        ? `(${shares(holding.quantity)})`
                        : shares(holding.quantity)}
                  </td>
                  <td
                    className={`${CELL} text-right text-dim`}
                    title={holding.side === "short" ? "Average proceeds per share shorted" : undefined}
                  >
                    {isCash ? "—" : price(holding.avgCostPerShare)}
                  </td>
                  <td className={`${CELL} text-right`}>
                    {isCash ? (
                      <span className="text-dim">—</span>
                    ) : holding.price === null ? (
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
                    {isCash ? <span className="text-dim">—</span> : money(holding.unrealizedGain)}
                  </td>
                  <td className={`${CELL} text-right ${toneFor(holding.unrealizedGain)}`}>
                    {isCash ? <span className="text-dim">—</span> : percent(holding.unrealizedGainPct)}
                  </td>
                  <td className={`${CELL} text-right ${toneFor(holding.irr ?? 0)}`}>
                    {isCash ? <span className="text-dim">—</span> : percent(holding.irr)}
                  </td>
                </tr>
                  );
                })}
            </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="sticky bottom-0 z-10 border-t border-border bg-panel font-semibold">
            <td className={`${CELL} text-left text-foreground`} colSpan={labelSpan}>
              Total
            </td>
            <td className={`${CELL} text-right text-foreground`}>{money(grandTotals.marketValue)}</td>
            <td className={`${CELL} text-right text-dim`}>{(grandTotals.weight * 100).toFixed(1)}%</td>
            <td className={`${CELL} text-right ${toneFor(grandTotals.unrealizedGain)}`}>
              {money(grandTotals.unrealizedGain)}
            </td>
            <td className={`${CELL} text-right ${toneFor(grandTotals.unrealizedGain)}`}>
              {percent(grandTotals.returnPct)}
            </td>
            <td className={CELL}></td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
  );
}
