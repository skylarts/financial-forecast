"use client";

import { Fragment, useMemo } from "react";
import { ASSET_CLASS_LABELS, INSTRUMENT_TYPE_LABELS, isOptionSymbol } from "@/domain/portfolio";
import { isStaleQuote, quoteAgeDays } from "@/lib/portfolio/quoteAge";
import { explodeExposures, type Holding } from "@/engine/portfolio/metrics";
import { money, percent, price, shares, shortDate, signedMoney, toneFor } from "@/lib/portfolio/format";
import { useSort, type SortAccessors, type SortState } from "./useSort";
import { SortHeader } from "./SortHeader";
import {
  buildGroups,
  buildNestedGroups,
  nestedAccountLabel,
  GroupHeaderRow,
  GroupMenu,
  groupedColumnMarker,
  orderGroupsBy,
  type CollapseState,
  type Group,
  type GroupingOption,
} from "./grouping";
import type { AccountGroup } from "@/lib/portfolio/accountTree";
import { UNTAGGED } from "./filters";
import { FOOT, FOOT_FROZEN, FROZEN_CELL, FROZEN_WIDTH, TABLE } from "./frozenColumn";

export type HoldingGrouping = "none" | "account" | "assetClass" | "theme" | "side" | "instrumentType";

/**
 * Only `account` names a column here. Class, theme, side and type describe a
 * holding without appearing in the table, which is why the grouping menu
 * lists every dimension in one place instead of hanging off the columns
 * individually.
 */
export const HOLDING_GROUPINGS: readonly GroupingOption<HoldingGrouping>[] = [
  { value: "none", label: "No grouping" },
  { value: "account", label: "By account", column: "account" },
  { value: "assetClass", label: "By class" },
  { value: "theme", label: "By theme" },
  { value: "side", label: "By side" },
  { value: "instrumentType", label: "By type" },
];

/** A row as actually rendered. Grouping by class or theme can turn one
 *  holding into several of these -- `source` is always the real, whole
 *  holding behind the row, which is what a click should open. */
type Row = Holding & { source: Holding; sliceNote?: string; groupLabel?: string };

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
  | "day"
  | "weight"
  | "unrealized"
  | "return"
  | "yield"
  | "irr";

/**
 * Columns whose group ordering should follow the group's subtotal rather than
 * its top row. Money columns only: a group's summed price or summed return
 * percentage isn't a figure, so those keep first-row order.
 */
const GROUP_TOTALS: Partial<Record<Column, (row: Row) => number>> = {
  value: (row) => row.marketValue,
  day: (row) => row.dayChange ?? 0,
  weight: (row) => row.weight,
  unrealized: (row) => row.unrealizedGain,
};

const CELL = "border-b border-border-soft px-3 py-2 text-[12.5px] tabular-nums";


interface GroupTotals {
  marketValue: number;
  costBasis: number;
  weight: number;
  unrealizedGain: number;
  /** Null when the group has no basis to measure against, same as a single row. */
  returnPct: number | null;
  /** Today's move summed over the rows that could measure one; null if none could. */
  dayChange: number | null;
  /** Trailing income over the group's value, or null with nothing to divide by. */
  dividendYield: number | null;
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
  const movers = rows.filter((h) => h.dayChange !== null);
  const incomeTtm = rows.reduce((sum, h) => sum + h.incomeTtm, 0);
  return {
    marketValue,
    costBasis,
    weight: rows.reduce((sum, h) => sum + h.weight, 0),
    unrealizedGain,
    returnPct: costBasis > 0 ? unrealizedGain / costBasis : null,
    dayChange: movers.length > 0 ? movers.reduce((sum, h) => sum + (h.dayChange ?? 0), 0) : null,
    dividendYield: incomeTtm > 0 && marketValue > 0 ? incomeTtm / marketValue : null,
  };
}

/**
 * The rows a grouping actually puts on screen, before sorting.
 *
 * Grouping by class or theme can turn one holding into several rows, so this
 * runs first and the sort runs over its output: sorting whole positions and
 * splitting them afterwards ranked every slice by money that mostly sits in
 * some other group -- a fund 90% in international stock led the US Equity
 * group on the strength of a slice a tenth its size.
 */
export function rowsFor(holdings: readonly Holding[], grouping: HoldingGrouping): Row[] {
  if (grouping === "assetClass") {
    // A single-class holding explodes into one row identical to itself; a
    // fund like VT explodes into one row per class it spans, each carrying
    // only its own slice of the value -- see `explodeExposures`.
    return explodeExposures(holdings).map((r) => ({
      ...r,
      source: r.source,
      groupLabel: ASSET_CLASS_LABELS[r.assetClass],
      sliceNote: r.exposureCount > 1 ? `${Math.round(r.exposureWeight * 100)}% of position` : undefined,
    }));
  }

  if (grouping === "theme") {
    // Unlike a class split, a theme tag doesn't divide the holding's value --
    // a position tagged both "Core" and "AI" shows its full value under each,
    // which is why the grand total is computed off the holdings rather than
    // off these rows.
    const rows: Row[] = [];
    for (const holding of holdings) {
      const tags = holding.themes.length > 0 ? holding.themes : [UNTAGGED];
      for (const tag of tags) {
        rows.push({
          ...holding,
          key: tags.length > 1 ? `${holding.key}::${tag}` : holding.key,
          source: holding,
          groupLabel: tag,
        });
      }
    }
    return rows;
  }

  return holdings.map(toRow);
}

/**
 * Sorted rows bucketed into groups, ordered by their own subtotal of whatever
 * money column is being sorted on.
 *
 * `rows` must already be sorted -- the buckets keep the order they arrive in,
 * so the sort is what orders positions inside each group.
 */
export function groupsFor(
  rows: readonly Row[],
  grouping: HoldingGrouping,
  accountNames: Map<string, string>,
  sort: SortState<Column>,
  accountGroups?: Map<string, AccountGroup>,
): Group<Row>[] {
  if (grouping === "none") {
    return [{ key: "", label: "", rows: [...rows], totalRows: [...rows], depth: 0, parentKey: null }];
  }

  // By account nests, because a pre-tax/Roth sleeve is a subdivision of one
  // account rather than an account in its own right.
  const built =
    grouping === "account"
      ? buildNestedGroups(rows, (row) => nestedAccountLabel(row.accountId, accountNames, accountGroups))
      : buildGroups(rows, (row) =>
          row.groupLabel ??
          (grouping === "instrumentType"
            ? INSTRUMENT_TYPE_LABELS[row.instrumentType] ?? row.instrumentType
            : row.side === "short"
              ? "Short positions"
              : "Long positions"),
        );

  const total = GROUP_TOTALS[sort.key];
  if (!total) return built;
  return orderGroupsBy(built, (grouped) => grouped.reduce((sum, row) => sum + total(row), 0), sort.direction);
}

export function HoldingsTable({
  holdings,
  accountNames,
  accountGroups,
  showAccount,
  grouping,
  onGroupingChange,
  collapse,
  onSelect,
}: {
  holdings: Holding[];
  accountNames: Map<string, string>;
  /** Which parent each account groups under, so a pre-tax/Roth sleeve nests
   *  inside its 401(k) instead of standing beside it. */
  accountGroups: Map<string, AccountGroup>;
  showAccount: boolean;
  grouping: HoldingGrouping;
  onGroupingChange: (next: HoldingGrouping) => void;
  /** Owned by the parent because switching it resets which groups are folded,
   *  and the parent is what knows the grouping changed. */
  collapse: CollapseState;
  onSelect: (holding: Holding) => void;
}) {
  const accessors = useMemo<SortAccessors<Row, Column>>(
    () => ({
      symbol: (h) => h.symbol,
      account: (h) => accountNames.get(h.accountId) ?? "",
      quantity: (h) => h.quantity,
      avgCost: (h) => h.avgCostPerShare,
      price: (h) => h.price ?? Number.NaN,
      value: (h) => h.marketValue,
      day: (h) => h.dayChange ?? Number.NaN,
      weight: (h) => h.weight,
      unrealized: (h) => h.unrealizedGain,
      return: (h) => h.unrealizedGainPct ?? Number.NaN,
      yield: (h) => h.dividendYield ?? Number.NaN,
      irr: (h) => h.irr ?? Number.NaN,
    }),
    [accountNames],
  );

  const { sort, toggle, apply } = useSort<Row, Column>(accessors, "value");

  const rows = useMemo(() => rowsFor(holdings, grouping), [holdings, grouping]);

  const sorted = useMemo(() => apply(rows), [apply, rows]);

  const groups = useMemo(
    () => groupsFor(sorted, grouping, accountNames, sort, accountGroups),
    [sorted, grouping, accountNames, sort, accountGroups],
  );

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
  // Totals over every visible holding regardless of group collapse -- collapsing
  // a group hides its rows, not its money. Off the holdings rather than the
  // rows, so a class split or a second theme tag can't count one position twice.
  const grandTotals = totalsFor(holdings);
  const groupedColumn = HOLDING_GROUPINGS.find((g) => g.value === grouping)?.column;

  return (
    <div className="overflow-x-auto">
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-panel">
      <table className={TABLE}>
        <thead>
          <tr>
            <SortHeader
              label="Holding"
              column="symbol"
              align="left"
              sort={sort}
              onToggle={toggle}
              frozen
              after={
                <GroupMenu
                  options={HOLDING_GROUPINGS}
                  value={grouping}
                  onChange={onGroupingChange}
                  collapse={collapse}
                />
              }
            />
            {showAccount && (
              <SortHeader
                label={`Account${groupedColumnMarker(groupedColumn, "account")}`}
                column="account"
                align="left"
                sort={sort}
                onToggle={toggle}
              />
            )}
            <SortHeader label="Shares" column="quantity" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Avg cost" column="avgCost" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Price" column="price" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Value" column="value" align="right" sort={sort} onToggle={toggle} />
            <SortHeader
              label="Day"
              column="day"
              align="right"
              sort={sort}
              onToggle={toggle}
              title="Change in this position since the previous close"
            />
            <SortHeader label="Weight" column="weight" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Unrealized" column="unrealized" align="right" sort={sort} onToggle={toggle} />
            <SortHeader label="Return" column="return" align="right" sort={sort} onToggle={toggle} />
            <SortHeader
              label="Yield"
              column="yield"
              align="right"
              sort={sort}
              onToggle={toggle}
              title="Dividends and interest over the last twelve months, as a share of today's value"
            />
            <SortHeader label="Annualized" column="irr" align="right" sort={sort} onToggle={toggle} />
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const totals = totalsFor(group.totalRows);
            const collapsed = grouping !== "none" && collapse.isCollapsed(group.key);
            // A subdivision disappears with the account it belongs to, header
            // and all -- a collapsed group that still lists its sleeves has
            // not collapsed.
            if (group.parentKey !== null && collapse.isCollapsed(group.parentKey)) return null;
            return (
            <Fragment key={group.key || "all"}>
              {grouping !== "none" && (
                <GroupHeaderRow
                  label={group.label}
                  count={group.totalRows.length}
                  collapsed={collapsed}
                  onToggle={() => collapse.toggle(group.key)}
                  depth={group.depth}
                  labelSpan={labelSpan}
                  summary={
                    <>
                      <span className="text-foreground">{money(totals.marketValue)}</span>
                      <span className={toneFor(totals.unrealizedGain)}>
                        {money(totals.unrealizedGain)}
                      </span>
                    </>
                  }
                  cells={[
                    <span key="value" className="text-foreground">
                      {money(totals.marketValue)}
                    </span>,
                    totals.dayChange === null ? null : (
                      <span key="day" className={toneFor(totals.dayChange)}>
                        {signedMoney(totals.dayChange)}
                      </span>
                    ),
                    <span key="weight" className="text-dim">
                      {(totals.weight * 100).toFixed(1)}%
                    </span>,
                    <span key="unrealized" className={toneFor(totals.unrealizedGain)}>
                      {money(totals.unrealizedGain)}
                    </span>,
                    <span key="return" className={toneFor(totals.unrealizedGain)}>
                      {percent(totals.returnPct)}
                    </span>,
                    totals.dividendYield === null ? null : (
                      <span key="yield" className="text-dim">
                        {percent(totals.dividendYield).replace("+", "")}
                      </span>
                    ),
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
                  className={`group transition-colors hover:bg-panel-2 ${
                    isCash ? "" : "cursor-pointer"
                  }`}
                >
                  <td className={`${CELL} ${FROZEN_CELL} text-left`}>
                    {/* The symbol leads, so what the cap trims is the tail of a long
                        fund name -- never the part that identifies the row. */}
                    <div className={`${FROZEN_WIDTH} truncate`}>
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
                    </div>
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
                      <span
                        className="rounded-sm border border-border px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-dim-2"
                        title={
                          isOptionSymbol(holding.symbol)
                            ? "No quote for this contract, so it is carried at what it cost. Its day move is left out of the totals."
                            : "No quote available, so this position is carried at what it cost. Its day move is left out of the totals."
                        }
                      >
                        At cost
                      </span>
                    ) : (
                      <PriceCell price={holding.price} date={holding.priceDate} />
                    )}
                  </td>
                  <td className={`${CELL} text-right font-semibold text-foreground`}>
                    {money(holding.marketValue)}
                  </td>
                  <td className={`${CELL} text-right ${holding.dayChange === null ? "text-dim" : toneFor(holding.dayChange)}`}>
                    {isCash || holding.dayChange === null ? (
                      "—"
                    ) : (
                      <span title={percent(holding.dayChangePct, 2)}>{signedMoney(holding.dayChange)}</span>
                    )}
                  </td>
                  <td className={`${CELL} text-right text-dim`}>{(holding.weight * 100).toFixed(1)}%</td>
                  <td className={`${CELL} text-right ${toneFor(holding.unrealizedGain)}`}>
                    {isCash ? <span className="text-dim">—</span> : money(holding.unrealizedGain)}
                  </td>
                  <td className={`${CELL} text-right ${toneFor(holding.unrealizedGain)}`}>
                    {isCash ? <span className="text-dim">—</span> : percent(holding.unrealizedGainPct)}
                  </td>
                  <td
                    className={`${CELL} text-right text-dim`}
                    title={
                      holding.dividendYield === null
                        ? undefined
                        : `${money(holding.incomeTtm)} of dividends and interest in the last twelve months`
                    }
                  >
                    {isCash || holding.dividendYield === null
                      ? "—"
                      : percent(holding.dividendYield).replace("+", "")}
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
          <tr>
            <td className={`${FOOT_FROZEN} text-left text-foreground`}>Total</td>
            <td className={FOOT} colSpan={labelSpan - 1}></td>
            <td className={`${FOOT} text-right text-foreground`}>{money(grandTotals.marketValue)}</td>
            <td className={`${FOOT} text-right ${grandTotals.dayChange === null ? "text-dim" : toneFor(grandTotals.dayChange)}`}>
              {grandTotals.dayChange === null ? "—" : signedMoney(grandTotals.dayChange)}
            </td>
            <td className={`${FOOT} text-right text-dim`}>{(grandTotals.weight * 100).toFixed(1)}%</td>
            <td className={`${FOOT} text-right ${toneFor(grandTotals.unrealizedGain)}`}>
              {money(grandTotals.unrealizedGain)}
            </td>
            <td className={`${FOOT} text-right ${toneFor(grandTotals.unrealizedGain)}`}>
              {percent(grandTotals.returnPct)}
            </td>
            <td className={`${FOOT} text-right text-dim`}>
              {grandTotals.dividendYield === null ? "" : percent(grandTotals.dividendYield).replace("+", "")}
            </td>
            <td className={`${FOOT}`}></td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
  );
}

/**
 * A price, and how old it is when that matters.
 *
 * A quote from the last trading day is just a number. One older than that --
 * a feed that answered from a stale session, or a cached price served after a
 * failed refresh -- carries the day it is from beside it, because a price
 * that looks current and isn't is the one that misvalues a position without
 * anyone noticing. Weekends don't count: Friday's close is current on Sunday.
 */
function PriceCell({ price: value, date }: { price: number; date: string | null }) {
  const today = new Date().toISOString().slice(0, 10);
  const stale = isStaleQuote(date, today);
  return (
    <span
      className={stale ? "text-dim" : "text-foreground"}
      title={
        date
          ? stale
            ? `As of ${shortDate(date)} — ${quoteAgeDays(date, today)} days old, not the latest close.`
            : `As of ${shortDate(date)}`
          : undefined
      }
    >
      {price(value)}
      {stale && date && (
        <span className="ml-1 text-[10px] uppercase tracking-wide text-dim-2">{shortDate(date).slice(0, 5)}</span>
      )}
    </span>
  );
}
