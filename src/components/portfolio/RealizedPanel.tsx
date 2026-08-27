"use client";

import { Fragment, useMemo, useState } from "react";
import type { ClosedLot } from "@/engine/portfolio/lots";
import type { PortfolioSummary } from "@/engine/portfolio/metrics";
import { lotTermLabel, money, percent, shares, shortDate, toneFor } from "@/lib/portfolio/format";
import {
  buildGroups,
  GroupHeaderRow,
  GroupMenu,
  groupedColumnMarker,
  useCollapsedGroups,
  type GroupingOption,
} from "./grouping";
import { FilterStatus } from "./FilterStatus";
import { OutcomeFilter, matchesOutcome, type Outcome } from "./OutcomeFilter";
import { useSort, type SortAccessors } from "./useSort";
import { SortHeader } from "./SortHeader";

const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

type RealizedGrouping = "none" | "symbol" | "account" | "term" | "year";

/** Every dimension names a column here, including tax year -- which is the
 *  Sold date read at a coarser grain. */
const GROUPINGS: readonly GroupingOption<RealizedGrouping>[] = [
  { value: "none", label: "No grouping" },
  { value: "symbol", label: "By stock", column: "symbol" },
  { value: "account", label: "By account", column: "account" },
  { value: "term", label: "By term", column: "term" },
  { value: "year", label: "By tax year", column: "disposed" },
];

type Column =
  | "symbol"
  | "account"
  | "acquired"
  | "disposed"
  | "quantity"
  | "costBasis"
  | "proceeds"
  | "gain"
  | "term";

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


/**
 * Realized gains, lot by lot.
 *
 * Grouping matters more here than on the holdings table: a year's disposals run
 * to hundreds of rows, and the questions actually being asked of them -- what
 * did this stock make me, what does this tax year owe -- are subtotal questions,
 * not row questions.
 */
export function RealizedPanel({
  closedLots,
  summary,
  accountNames,
}: {
  closedLots: ClosedLot[];
  summary: PortfolioSummary;
  accountNames: Map<string, string>;
}) {
  const [grouping, setGrouping] = useState<RealizedGrouping>("none");
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("all");

  const accessors = useMemo<SortAccessors<ClosedLot, Column>>(
    () => ({
      symbol: (lot) => lot.symbol,
      account: (lot) => accountNames.get(lot.accountId) ?? "",
      acquired: (lot) => lot.acquiredDate,
      disposed: (lot) => lot.disposedDate,
      quantity: (lot) => lot.quantity,
      costBasis: (lot) => lot.costBasis,
      proceeds: (lot) => lot.proceeds,
      gain: (lot) => lot.gain,
      term: (lot) => lotTermLabel(lot),
    }),
    [accountNames],
  );
  const { sort, toggle, apply } = useSort<ClosedLot, Column>(accessors, "disposed");

  const filtered = useMemo(() => {
    const query = search.trim().toUpperCase();
    return closedLots.filter((lot) => {
      // Untaxed disposals realized nothing. Shares moved out to another account
      // close at zero proceeds, so listing them here would read as a total loss
      // on the whole position -- and the summary above already excludes them,
      // which is exactly the mismatch that makes this table look wrong.
      if (!lot.taxable) return false;
      if (query && !lot.symbol.includes(query)) return false;
      if (!matchesOutcome(outcome, lot.gain)) return false;
      return true;
    });
  }, [closedLots, search, outcome]);

  const sorted = useMemo(() => apply(filtered), [apply, filtered]);

  const groups = useMemo(() => {
    if (grouping === "none") return [{ key: "", label: "", rows: sorted }];
    const labelFor = (lot: ClosedLot) =>
      grouping === "symbol"
        ? lot.symbol
        : grouping === "account"
          ? accountNames.get(lot.accountId) ?? "Unknown account"
          : grouping === "term"
            ? lotTermLabel(lot)
            : lot.disposedDate.slice(0, 4);

    return buildGroups(sorted, labelFor);
  }, [sorted, grouping, accountNames]);

  // Opens collapsed: picking a grouping here is asking for the subtotals --
  // the hundreds of underlying rows are what the grouping was meant to fold away.
  const collapse = useCollapsedGroups(grouping, { defaultCollapsed: true });
  const groupedColumn = GROUPINGS.find((g) => g.value === grouping)?.column;

  // Symbol, Account, Acquired, Sold, Shares -- none of which sums meaningfully
  // across lots of different securities bought on different days.
  const labelSpan = 5;

  return (
    <div className="p-5">
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Realized YTD"
          value={money(summary.realizedGainYtd)}
          tone={toneFor(summary.realizedGainYtd)}
        />
        <Stat
          label="Short-term"
          value={money(summary.realizedShortTerm)}
          tone={toneFor(summary.realizedShortTerm)}
        />
        <Stat
          label="Long-term"
          value={money(summary.realizedLongTerm)}
          tone={toneFor(summary.realizedLongTerm)}
        />
        <Stat label="Dividends & interest" value={money(summary.income)} />
      </div>

      {closedLots.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">
          No closed positions yet. Sells will show up here with their tax lots matched.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search symbol"
              className="w-44 rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
            />
            <OutcomeFilter value={outcome} onChange={setOutcome} />
            <FilterStatus
              shown={sorted.length}
              total={closedLots.length}
              noun="lots"
              active={search !== "" || outcome !== "all"}
              onClear={() => {
                setSearch("");
                setOutcome("all");
              }}
            />
          </div>

          {sorted.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-dim">
              No closed lots match those filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <div className="max-h-[70vh] overflow-auto rounded-md border border-border-soft">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="sticky top-0 z-10 border-b border-border bg-panel">
                    <SortHeader
                      label={`Symbol${groupedColumnMarker(groupedColumn, "symbol")}`}
                      column="symbol"
                      align="left"
                      sort={sort}
                      onToggle={toggle}
                      after={
                        <GroupMenu
                          options={GROUPINGS}
                          value={grouping}
                          onChange={setGrouping}
                          collapse={collapse}
                        />
                      }
                    />
                    <SortHeader
                      label={`Account${groupedColumnMarker(groupedColumn, "account")}`}
                      column="account"
                      align="left"
                      sort={sort}
                      onToggle={toggle}
                    />
                    <SortHeader label="Acquired" column="acquired" align="left" sort={sort} onToggle={toggle} />
                    <SortHeader
                      label={`Sold${groupedColumnMarker(groupedColumn, "disposed")}`}
                      column="disposed"
                      align="left"
                      sort={sort}
                      onToggle={toggle}
                    />
                    <SortHeader label="Shares" column="quantity" align="right" sort={sort} onToggle={toggle} />
                    <SortHeader label="Cost basis" column="costBasis" align="right" sort={sort} onToggle={toggle} />
                    <SortHeader label="Proceeds" column="proceeds" align="right" sort={sort} onToggle={toggle} />
                    <SortHeader label="Gain" column="gain" align="right" sort={sort} onToggle={toggle} />
                    <SortHeader
                      label={`Term${groupedColumnMarker(groupedColumn, "term")}`}
                      column="term"
                      align="right"
                      sort={sort}
                      onToggle={toggle}
                    />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => {
                    const costBasis = group.rows.reduce((s, lot) => s + lot.costBasis, 0);
                    const proceeds = group.rows.reduce((s, lot) => s + lot.proceeds, 0);
                    const gain = group.rows.reduce((s, lot) => s + lot.gain, 0);
                    const collapsed = grouping !== "none" && collapse.isCollapsed(group.key);
                    return (
                      <Fragment key={group.key || "all"}>
                        {grouping !== "none" && (
                          <GroupHeaderRow
                            label={group.label}
                            count={group.rows.length}
                            noun="lot"
                            collapsed={collapsed}
                            onToggle={() => collapse.toggle(group.key)}
                            labelSpan={labelSpan}
                            cells={[
                              <span key="basis" className="text-dim">
                                {money(costBasis)}
                              </span>,
                              <span key="proceeds" className="text-dim">
                                {money(proceeds)}
                              </span>,
                              <span key="gain" className={toneFor(gain)}>
                                {money(gain)}
                              </span>,
                              <span key="return" className={toneFor(gain)}>
                                {percent(costBasis > 0 ? gain / costBasis : null)}
                              </span>,
                            ]}
                          />
                        )}
                        {!collapsed &&
                          group.rows.map((lot, i) => (
                            <tr key={`${lot.closeTxId}-${i}`} className="border-b border-border-soft">
                              <td className={`${CELL} text-left font-semibold text-foreground`}>
                                {lot.symbol}
                              </td>
                              <td className={`${CELL} text-left text-dim`}>
                                {accountNames.get(lot.accountId) ?? "—"}
                              </td>
                              <td className={`${CELL} text-left text-dim`}>{shortDate(lot.acquiredDate)}</td>
                              <td className={`${CELL} text-left text-dim`}>{shortDate(lot.disposedDate)}</td>
                              <td className={`${CELL} text-right text-dim`}>{shares(lot.quantity)}</td>
                              <td className={`${CELL} text-right text-dim`}>{money(lot.costBasis)}</td>
                              <td className={`${CELL} text-right text-dim`}>{money(lot.proceeds)}</td>
                              <td className={`${CELL} text-right ${toneFor(lot.gain)}`}>{money(lot.gain)}</td>
                              <td className={`${CELL} text-right text-dim`}>{lotTermLabel(lot)}</td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="sticky bottom-0 z-10 border-t border-border bg-panel font-semibold">
                    <td className={`${CELL} text-left text-foreground`} colSpan={labelSpan}>
                      Total
                    </td>
                    <td className={`${CELL} text-right text-foreground`}>
                      {money(sorted.reduce((s, lot) => s + lot.costBasis, 0))}
                    </td>
                    <td className={`${CELL} text-right text-foreground`}>
                      {money(sorted.reduce((s, lot) => s + lot.proceeds, 0))}
                    </td>
                    {(() => {
                      const totalGain = sorted.reduce((s, lot) => s + lot.gain, 0);
                      return (
                        <td className={`${CELL} text-right ${toneFor(totalGain)}`}>{money(totalGain)}</td>
                      );
                    })()}
                    <td className={CELL}></td>
                  </tr>
                </tfoot>
              </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
