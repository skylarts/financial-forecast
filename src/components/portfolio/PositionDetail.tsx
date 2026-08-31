"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Id } from "@/domain";
import type { Transaction } from "@/domain/portfolio";
import { normalizeSymbol, TRANSACTION_TYPE_LABELS } from "@/domain/portfolio";
import type { ClosedLot, OpenLot } from "@/engine/portfolio/lots";
import type { Holding } from "@/engine/portfolio/metrics";
import { rollUpBySymbol } from "@/engine/portfolio/bySymbol";
import { lotTermLabel, money, percent, price, shares, shortDate, toneFor } from "@/lib/portfolio/format";
import { Segmented } from "@/components/ui/controls";
import type { PricePoint } from "./PriceChart";
import { MoreRows, useRowWindow } from "./rowWindow";

/**
 * The Holdings tab -- almost always the first thing this page shows -- opens
 * this drawer eagerly enough that a static import would have pulled Recharts
 * into the tab's own bundle just for a chart that isn't shown until a row is
 * clicked. Deferred here instead of loaded up front.
 */
const PriceChart = dynamic(() => import("./PriceChart").then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-md bg-panel-2" />,
});

/**
 * Which position this drawer is open on.
 *
 * A symbol rather than a `Holding`, because most of the places that open it --
 * a realized lot, an allocation slice, a fully closed name on the by-stock
 * table -- have no holding to hand over. `accountId` narrows to one account's
 * side of the name, which is what a Holdings row means by a click; null means
 * every account in the current scope, which is what everywhere else means.
 */
export interface PositionSelection {
  symbol: string;
  accountId: Id | null;
}

/**
 * Chart ranges, short end first.
 *
 * 10Y is gone: at daily resolution it draws the same picture as Max for all but
 * the oldest holdings, and it crowded out the short windows that answer what
 * this position has done lately.
 */
const RANGES = [
  { value: "1mo", label: "1M" },
  { value: "3mo", label: "3M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "5y", label: "5Y" },
  { value: "max", label: "Max" },
] as const;

type Range = (typeof RANGES)[number]["value"] | "custom";

/** Fetch window backing a custom range. Clipped client-side to the exact dates. */
const CUSTOM_FETCH_RANGE = "max";

const HEAD = "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-3 py-1.5 text-[12px] tabular-nums";

function Stat({ label, value, tone = "", hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-panel-2 px-3 py-2" title={hint}>
      <div className="text-[10.5px] uppercase tracking-wide text-dim-2">{label}</div>
      <div className={`mt-0.5 text-[15px] font-semibold tabular-nums ${tone || "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

/**
 * The shortest range that still shows every trade on this name.
 *
 * A closed position's whole story is behind it, and opening on the stock's
 * last twelve months would draw a chart with none of your own buys or sells
 * on it -- which is the one thing this chart is for.
 */
function rangeCovering(firstTradeDate: string | null): Range {
  if (firstTradeDate === null) return "1y";
  const days = (Date.now() - Date.parse(`${firstTradeDate}T00:00:00Z`)) / 86_400_000;
  if (days <= 90) return "3mo";
  if (days <= 365) return "1y";
  if (days <= 5 * 365) return "5y";
  return "max";
}

/** Days held, rounded, or an em dash when there are no closed lots to average. */
function holdPeriod(days: number | null): string {
  if (days === null) return "—";
  const rounded = Math.round(days);
  return `${rounded.toLocaleString()} day${rounded === 1 ? "" : "s"}`;
}

/**
 * Everything the tracker knows about one name, in one drawer.
 *
 * Open lots, closed round trips, dividends, and the price chart with your own
 * buys and sells on it -- the same panel whether the position is still held or
 * was closed out years ago, and whether it's one account's slice of the name or
 * every account's at once.
 */
export function PositionDetail({
  selection,
  holdings,
  closedLots,
  transactions,
  accountNames,
  onClose,
}: {
  selection: PositionSelection;
  /** Every holding in the current account scope; narrowed to the selection here. */
  holdings: Holding[];
  closedLots: ClosedLot[];
  /** Transactions already narrowed to the current account scope. */
  transactions: Transaction[];
  accountNames: Map<string, string>;
  onClose: () => void;
}) {
  const { symbol, accountId } = selection;

  // Read straight off the props rather than off the memo below, because the
  // opening range is decided on the first render, before any of it exists.
  const firstTradeDate = transactions.reduce<string | null>((earliest, tx) => {
    if (tx.symbol === null || normalizeSymbol(tx.symbol) !== symbol) return earliest;
    if (accountId !== null && tx.accountId !== accountId) return earliest;
    return earliest === null || tx.date < earliest ? tx.date : earliest;
  }, null);

  const [range, setRange] = useState<Range>(() => rangeCovering(firstTradeDate));
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; points: PricePoint[] } | null>(null);

  const openHoldings = useMemo(
    () =>
      holdings.filter(
        (h) =>
          h.kind === "position" &&
          h.symbol === symbol &&
          (accountId === null || h.accountId === accountId),
      ),
    [holdings, symbol, accountId],
  );
  const lotsClosed = useMemo(
    () =>
      closedLots
        .filter(
          (lot) => lot.symbol === symbol && (accountId === null || lot.accountId === accountId),
        )
        .sort((a, b) => (a.disposedDate < b.disposedDate ? 1 : -1)),
    [closedLots, symbol, accountId],
  );
  const txs = useMemo(
    () =>
      transactions
        .filter(
          (tx) =>
            tx.symbol !== null &&
            normalizeSymbol(tx.symbol) === symbol &&
            (accountId === null || tx.accountId === accountId),
        )
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    [transactions, symbol, accountId],
  );

  /**
   * The same per-symbol roll-up the by-stock table ranks on, run over just this
   * selection. Reused rather than re-summed here so the drawer can never
   * disagree with that table about what a name has made -- including on the
   * details that are easy to get wrong alone, like untaxed disposals staying
   * out of the trade stats.
   */
  const rollup = useMemo(
    () => rollUpBySymbol(openHoldings, lotsClosed)[0] ?? null,
    [openHoldings, lotsClosed],
  );

  const openLots: OpenLot[] = useMemo(
    () =>
      openHoldings
        .flatMap((h) => h.lots)
        .sort((a, b) => (a.acquiredDate < b.acquiredDate ? -1 : 1)),
    [openHoldings],
  );

  // Three independent lists behind one holding, each windowed on its own. The
  // open-lot list is the one that forced this: a fund bought every payday for
  // fifteen years has tens of thousands of open lots, and drawing them all was
  // enough on its own to hang the drawer open.
  const openWindow = useRowWindow(openLots);
  const closedWindow = useRowWindow(lotsClosed);
  const txWindow = useRowWindow(txs);

  // A custom window is served by clipping the full history rather than by
  // asking the feed for arbitrary dates: the feed only speaks in named ranges,
  // and the full series is cached anyway, so this costs one fetch and then none.
  const fetchRange = range === "custom" ? CUSTOM_FETCH_RANGE : range;
  const requestKey = `${symbol}:${fetchRange}`;

  useEffect(() => {
    let cancelled = false;
    const [requestedSymbol, requestedRange] = requestKey.split(":");
    fetch(`/api/prices/history?symbol=${encodeURIComponent(requestedSymbol)}&range=${requestedRange}`)
      .then((r) => (r.ok ? r.json() : { points: [] }))
      .then((body: { points?: PricePoint[] }) => {
        if (!cancelled) setLoaded({ key: requestKey, points: body.points ?? [] });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: requestKey, points: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  // Derived rather than a separate flag, so switching range can't leave the
  // previous symbol's series on screen looking like the new one's.
  const loading = loaded?.key !== requestKey;

  const points = useMemo(() => {
    const fetched = loaded?.key === requestKey ? loaded.points : [];
    if (range !== "custom" || (!fromDate && !toDate)) return fetched;
    return fetched.filter(
      (point) => (!fromDate || point.date >= fromDate) && (!toDate || point.date <= toDate),
    );
  }, [loaded, requestKey, range, fromDate, toDate]);

  const trades = txs.filter(
    (tx) => tx.quantity > 0 && tx.type !== "split" && tx.type !== "dividend",
  );

  const price0 = openHoldings.find((h) => h.price !== null)?.price ?? null;
  const isOpen = rollup?.isOpen ?? false;
  // A name can fall out of the roll-up entirely and still have history worth
  // reading -- one whose only disposals were untaxed transfers, say. Only a
  // selection with no lots and no ledger rows at all is genuinely empty.
  const nothingHere = rollup === null && lotsClosed.length === 0 && txs.length === 0;
  const name = rollup?.name ?? symbol;
  // A closed name held in several accounts is combined here, so the tables say
  // which account each row came from rather than listing near-identical lots.
  const showAccount = accountId === null && (rollup?.accountCount ?? 0) > 1;
  const scopeLabel =
    accountId !== null
      ? accountNames.get(accountId) ?? null
      : showAccount
        ? `${rollup?.accountCount} accounts`
        : null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-4xl flex-col overflow-y-auto border-l border-border bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-panel px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-[18px] font-semibold text-foreground">
              {symbol}
              {!isOpen && (
                <span
                  title="Nothing held any more — everything below is history."
                  className="rounded-sm border border-border px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-dim-2"
                >
                  Closed
                </span>
              )}
            </h2>
            <p className="text-[12.5px] text-dim">
              {name !== symbol && name}
              {name !== symbol && scopeLabel && <span className="text-dim-2"> · </span>}
              {scopeLabel && <span className="text-dim-2">{scopeLabel}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-dim hover:text-foreground"
          >
            Close
          </button>
        </div>

        {nothingHere ? (
          <p className="px-5 py-8 text-[13px] text-dim">
            Nothing on {symbol} in the current account scope.
          </p>
        ) : (
          <>
            {rollup !== null && (
            <div className="grid grid-cols-2 gap-2 px-5 py-4 sm:grid-cols-4">
              {isOpen ? (
                <>
                  <Stat label="Value" value={money(rollup.marketValue)} />
                  <Stat label="Shares" value={shares(rollup.quantity)} />
                  <Stat
                    label="Avg cost"
                    value={price(rollup.quantity > 0 ? rollup.openCostBasis / rollup.quantity : 0)}
                  />
                  <Stat label="Weight" value={`${(rollup.weight * 100).toFixed(1)}%`} />
                  <Stat
                    label="Unrealized"
                    value={money(rollup.unrealizedGain)}
                    tone={toneFor(rollup.unrealizedGain)}
                  />
                  <Stat
                    label="Return"
                    value={percent(
                      rollup.openCostBasis > 0 ? rollup.unrealizedGain / rollup.openCostBasis : null,
                    )}
                    tone={toneFor(rollup.unrealizedGain)}
                    hint="Unrealized gain over the basis of what you still hold."
                  />
                  <Stat
                    label="Realized"
                    value={money(rollup.realizedGain)}
                    tone={toneFor(rollup.realizedGain)}
                  />
                  <Stat label="Dividends" value={money(rollup.income)} />
                </>
              ) : (
                <>
                  <Stat
                    label="Realized"
                    value={money(rollup.realizedGain)}
                    tone={toneFor(rollup.realizedGain)}
                    hint="Everything this name booked before you closed it out."
                  />
                  <Stat
                    label="Return"
                    value={percent(
                      rollup.closedCostBasis > 0 ? rollup.realizedGain / rollup.closedCostBasis : null,
                    )}
                    tone={toneFor(rollup.realizedGain)}
                    hint="Realized gain over what those shares cost."
                  />
                  <Stat label="Dividends" value={money(rollup.income)} />
                  <Stat
                    label="Total gain"
                    value={money(rollup.totalGain)}
                    tone={toneFor(rollup.totalGain)}
                    hint="Trades and dividends together, over the whole life of the position."
                  />
                </>
              )}
            </div>
            )}

            {rollup !== null && rollup.tradeCount > 0 && (
              <div className="grid grid-cols-2 gap-2 px-5 pb-4 sm:grid-cols-4">
                <Stat
                  label="Round trips"
                  value={`${rollup.winCount}/${rollup.tradeCount}`}
                  hint="Closed lots that made money, out of every closed lot."
                />
                <Stat label="Win rate" value={percent(rollup.winRate, 0)} />
                <Stat label="Avg hold" value={holdPeriod(rollup.avgHoldDays)} />
                <Stat
                  label="Best / worst"
                  value={`${money(rollup.bestTrade ?? 0)} / ${money(rollup.worstTrade ?? 0)}`}
                  hint="The single best and worst closed lots on this name."
                />
              </div>
            )}

            <div className="px-5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold text-foreground">Price history</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    options={RANGES}
                    value={range === "custom" ? ("" as Range) : range}
                    onChange={setRange}
                    size="sm"
                    ariaLabel="Chart range"
                  />
                  <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
                    From
                    <input
                      type="date"
                      value={fromDate}
                      max={toDate || undefined}
                      onChange={(e) => {
                        setFromDate(e.target.value);
                        setRange("custom");
                      }}
                      className="rounded-md border border-border bg-panel-2 px-1.5 py-1 text-[11.5px] text-foreground outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
                    To
                    <input
                      type="date"
                      value={toDate}
                      min={fromDate || undefined}
                      onChange={(e) => {
                        setToDate(e.target.value);
                        setRange("custom");
                      }}
                      className="rounded-md border border-border bg-panel-2 px-1.5 py-1 text-[11.5px] text-foreground outline-none focus:border-accent"
                    />
                  </label>
                  {range === "custom" && (
                    <button
                      type="button"
                      onClick={() => {
                        setFromDate("");
                        setToDate("");
                        setRange("1y");
                      }}
                      className="text-[11.5px] text-dim-2 underline hover:text-foreground"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              {loading ? (
                <div className="flex h-64 items-center justify-center text-[13px] text-dim">
                  Loading price history…
                </div>
              ) : (
                <PriceChart points={points} transactions={trades} />
              )}
            </div>

            {openLots.length > 0 && (
              <div className="px-5 py-5">
                <h3 className="mb-2 text-[13px] font-semibold text-foreground">
                  Open tax lots ({openLots.length})
                </h3>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={`${HEAD} text-left`}>Acquired</th>
                      <th className={`${HEAD} text-left`}>Lot</th>
                      {showAccount && <th className={`${HEAD} text-left`}>Account</th>}
                      <th className={`${HEAD} text-right`}>Shares</th>
                      <th className={`${HEAD} text-right`}>Cost basis</th>
                      <th className={`${HEAD} text-right`}>Cost/share</th>
                      <th className={`${HEAD} text-right`}>Value</th>
                      <th className={`${HEAD} text-right`}>Gain</th>
                      <th className={`${HEAD} text-right`}>Term</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openLots.slice(0, openWindow.limit()).map((lot) => {
                      const value = price0 === null ? lot.costBasis : lot.quantity * price0;
                      const gain = value - lot.costBasis;
                      const heldSince = new Date(`${lot.acquiredDate}T00:00:00`);
                      const oneYearOn = new Date(heldSince);
                      oneYearOn.setFullYear(oneYearOn.getFullYear() + 1);
                      const isLong = new Date() > oneYearOn;
                      return (
                        <tr key={`${lot.accountId}-${lot.id}-${lot.openTxId}`} className="border-b border-border-soft">
                          <td className={`${CELL} text-left text-dim`}>{shortDate(lot.acquiredDate)}</td>
                          <td className={`${CELL} text-left text-dim-2`}>{lot.id}</td>
                          {showAccount && (
                            <td className={`${CELL} text-left text-dim`}>
                              {accountNames.get(lot.accountId) ?? "—"}
                            </td>
                          )}
                          <td className={`${CELL} text-right text-dim`}>{shares(lot.quantity)}</td>
                          <td className={`${CELL} text-right text-dim`}>{money(lot.costBasis)}</td>
                          <td className={`${CELL} text-right text-dim`}>
                            {price(lot.quantity > 0 ? lot.costBasis / lot.quantity : 0)}
                          </td>
                          <td className={`${CELL} text-right text-foreground`}>{money(value)}</td>
                          <td className={`${CELL} text-right ${toneFor(gain)}`}>{money(gain)}</td>
                          <td className={`${CELL} text-right ${isLong ? "text-positive" : "text-dim"}`}>
                            {isLong ? "Long" : "Short"}
                          </td>
                        </tr>
                      );
                    })}
                  {openLots.length > openWindow.limit() && (
                    <tr>
                      <td colSpan={9} className="px-3 py-2">
                        <MoreRows
                          shown={openWindow.limit()}
                          total={openLots.length}
                          noun="lot"
                          onMore={(count) => openWindow.more(count)}
                          onAll={() => openWindow.all(openLots.length)}
                        />
                      </td>
                    </tr>
                  )}
                  </tbody>
                </table>
              </div>
            )}

            {lotsClosed.length > 0 && (
              <div className="px-5 pb-5 pt-5">
                <h3 className="mb-2 text-[13px] font-semibold text-foreground">
                  Closed lots ({lotsClosed.length})
                </h3>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={`${HEAD} text-left`}>Acquired</th>
                      <th className={`${HEAD} text-left`}>Sold</th>
                      <th className={`${HEAD} text-left`}>Lot</th>
                      {showAccount && <th className={`${HEAD} text-left`}>Account</th>}
                      <th className={`${HEAD} text-right`}>Shares</th>
                      <th className={`${HEAD} text-right`}>Cost basis</th>
                      <th className={`${HEAD} text-right`}>Proceeds</th>
                      <th className={`${HEAD} text-right`}>Gain</th>
                      <th className={`${HEAD} text-right`}>Term</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lotsClosed.slice(0, closedWindow.limit()).map((lot, i) => (
                      <tr key={`${lot.closeTxId}-${i}`} className="border-b border-border-soft">
                        <td className={`${CELL} text-left text-dim`}>{shortDate(lot.acquiredDate)}</td>
                        <td className={`${CELL} text-left text-dim`}>{shortDate(lot.disposedDate)}</td>
                        <td className={`${CELL} text-left text-dim-2`}>
                          {lot.unmatched ? (
                            <span className="text-negative" title="No purchase in the ledger backs these shares, so they were counted at zero cost basis.">
                              unmatched
                            </span>
                          ) : (
                            lot.id
                          )}
                        </td>
                        {showAccount && (
                          <td className={`${CELL} text-left text-dim`}>
                            {accountNames.get(lot.accountId) ?? "—"}
                          </td>
                        )}
                        <td className={`${CELL} text-right text-dim`}>{shares(lot.quantity)}</td>
                        <td className={`${CELL} text-right text-dim`}>{money(lot.costBasis)}</td>
                        <td className={`${CELL} text-right text-dim`}>{money(lot.proceeds)}</td>
                        <td className={`${CELL} text-right ${toneFor(lot.gain)}`}>{money(lot.gain)}</td>
                        <td className={`${CELL} text-right text-dim`}>{lotTermLabel(lot)}</td>
                      </tr>
                    ))}
                  {lotsClosed.length > closedWindow.limit() && (
                    <tr>
                      <td colSpan={9} className="px-3 py-2">
                        <MoreRows
                          shown={closedWindow.limit()}
                          total={lotsClosed.length}
                          noun="lot"
                          onMore={(count) => closedWindow.more(count)}
                          onAll={() => closedWindow.all(lotsClosed.length)}
                        />
                      </td>
                    </tr>
                  )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="px-5 pb-8 pt-5">
              <h3 className="mb-2 text-[13px] font-semibold text-foreground">
                Transactions ({txs.length})
              </h3>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className={`${HEAD} text-left`}>Date</th>
                    <th className={`${HEAD} text-left`}>Type</th>
                    {showAccount && <th className={`${HEAD} text-left`}>Account</th>}
                    <th className={`${HEAD} text-right`}>Shares</th>
                    <th className={`${HEAD} text-right`}>Price</th>
                    <th className={`${HEAD} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.slice(0, txWindow.limit()).map((tx) => (
                    <tr key={tx.id} className="border-b border-border-soft">
                      <td className={`${CELL} text-left text-dim`}>{shortDate(tx.date)}</td>
                      <td className={`${CELL} text-left text-foreground`}>
                        {TRANSACTION_TYPE_LABELS[tx.type]}
                      </td>
                      {showAccount && (
                        <td className={`${CELL} text-left text-dim`}>
                          {accountNames.get(tx.accountId) ?? "—"}
                        </td>
                      )}
                      <td className={`${CELL} text-right text-dim`}>
                        {tx.quantity > 0 ? shares(tx.quantity) : "—"}
                      </td>
                      <td className={`${CELL} text-right text-dim`}>
                        {tx.price > 0 ? price(tx.price) : "—"}
                      </td>
                      <td className={`${CELL} text-right text-dim`}>
                        {tx.amount === null ? money(tx.quantity * tx.price) : money(tx.amount)}
                      </td>
                    </tr>
                  ))}
                {txs.length > txWindow.limit() && (
                    <tr>
                      <td colSpan={6} className="px-3 py-2">
                        <MoreRows
                          shown={txWindow.limit()}
                          total={txs.length}
                          noun="transaction"
                          onMore={(count) => txWindow.more(count)}
                          onAll={() => txWindow.all(txs.length)}
                        />
                      </td>
                    </tr>
                  )}
                  </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
