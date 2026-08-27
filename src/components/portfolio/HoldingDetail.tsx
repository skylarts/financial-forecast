"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Transaction } from "@/domain/portfolio";
import { TRANSACTION_TYPE_LABELS } from "@/domain/portfolio";
import type { ClosedLot } from "@/engine/portfolio/lots";
import type { Holding } from "@/engine/portfolio/metrics";
import { lotTermLabel, money, percent, price, shares, shortDate, toneFor } from "@/lib/portfolio/format";
import { Segmented } from "@/components/ui/controls";
import type { PricePoint } from "./PriceChart";

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

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-panel-2 px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wide text-dim-2">{label}</div>
      <div className={`mt-0.5 text-[15px] font-semibold tabular-nums ${tone || "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

export function HoldingDetail({
  holding,
  transactions,
  closedLots,
  onClose,
}: {
  holding: Holding;
  transactions: Transaction[];
  closedLots: ClosedLot[];
  onClose: () => void;
}) {
  const [range, setRange] = useState<Range>("1y");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; points: PricePoint[] } | null>(null);

  // A custom window is served by clipping the full history rather than by
  // asking the feed for arbitrary dates: the feed only speaks in named ranges,
  // and the full series is cached anyway, so this costs one fetch and then none.
  const fetchRange = range === "custom" ? CUSTOM_FETCH_RANGE : range;
  const requestKey = `${holding.symbol}:${fetchRange}`;

  useEffect(() => {
    let cancelled = false;
    const [symbol, requestedRange] = requestKey.split(":");
    fetch(`/api/prices/history?symbol=${encodeURIComponent(symbol)}&range=${requestedRange}`)
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

  const trades = transactions.filter(
    (tx) => tx.quantity > 0 && tx.type !== "split" && tx.type !== "dividend",
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-4xl flex-col overflow-y-auto border-l border-border bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-panel px-5 py-4">
          <div>
            <h2 className="text-[18px] font-semibold text-foreground">{holding.symbol}</h2>
            {holding.name !== holding.symbol && (
              <p className="text-[12.5px] text-dim">{holding.name}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-dim hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 px-5 py-4 sm:grid-cols-4">
          <Stat label="Value" value={money(holding.marketValue)} />
          <Stat label="Shares" value={shares(holding.quantity)} />
          <Stat label="Avg cost" value={price(holding.avgCostPerShare)} />
          <Stat label="Weight" value={`${(holding.weight * 100).toFixed(1)}%`} />
          <Stat
            label="Unrealized"
            value={money(holding.unrealizedGain)}
            tone={toneFor(holding.unrealizedGain)}
          />
          <Stat
            label="Return"
            value={percent(holding.unrealizedGainPct)}
            tone={toneFor(holding.unrealizedGain)}
          />
          <Stat
            label="Realized"
            value={money(holding.realizedGain)}
            tone={toneFor(holding.realizedGain)}
          />
          <Stat label="Dividends" value={money(holding.income)} />
        </div>

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

        <div className="px-5 py-5">
          <h3 className="mb-2 text-[13px] font-semibold text-foreground">
            Open tax lots ({holding.lots.length})
          </h3>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className={`${HEAD} text-left`}>Acquired</th>
                <th className={`${HEAD} text-left`}>Lot</th>
                <th className={`${HEAD} text-right`}>Shares</th>
                <th className={`${HEAD} text-right`}>Cost basis</th>
                <th className={`${HEAD} text-right`}>Cost/share</th>
                <th className={`${HEAD} text-right`}>Value</th>
                <th className={`${HEAD} text-right`}>Gain</th>
                <th className={`${HEAD} text-right`}>Term</th>
              </tr>
            </thead>
            <tbody>
              {holding.lots.map((lot) => {
                const value = holding.price === null ? lot.costBasis : lot.quantity * holding.price;
                const gain = value - lot.costBasis;
                const heldSince = new Date(`${lot.acquiredDate}T00:00:00`);
                const oneYearOn = new Date(heldSince);
                oneYearOn.setFullYear(oneYearOn.getFullYear() + 1);
                const isLong = new Date() > oneYearOn;
                return (
                  <tr key={`${lot.id}-${lot.openTxId}`} className="border-b border-border-soft">
                    <td className={`${CELL} text-left text-dim`}>{shortDate(lot.acquiredDate)}</td>
                    <td className={`${CELL} text-left text-dim-2`}>{lot.id}</td>
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
            </tbody>
          </table>
        </div>

        {closedLots.length > 0 && (
          <div className="px-5 pb-5">
            <h3 className="mb-2 text-[13px] font-semibold text-foreground">
              Closed lots ({closedLots.length})
            </h3>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={`${HEAD} text-left`}>Acquired</th>
                  <th className={`${HEAD} text-left`}>Sold</th>
                  <th className={`${HEAD} text-left`}>Lot</th>
                  <th className={`${HEAD} text-right`}>Shares</th>
                  <th className={`${HEAD} text-right`}>Cost basis</th>
                  <th className={`${HEAD} text-right`}>Proceeds</th>
                  <th className={`${HEAD} text-right`}>Gain</th>
                  <th className={`${HEAD} text-right`}>Term</th>
                </tr>
              </thead>
              <tbody>
                {closedLots.map((lot, i) => (
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
                    <td className={`${CELL} text-right text-dim`}>{shares(lot.quantity)}</td>
                    <td className={`${CELL} text-right text-dim`}>{money(lot.costBasis)}</td>
                    <td className={`${CELL} text-right text-dim`}>{money(lot.proceeds)}</td>
                    <td className={`${CELL} text-right ${toneFor(lot.gain)}`}>{money(lot.gain)}</td>
                    <td className={`${CELL} text-right text-dim`}>
                      {lotTermLabel(lot)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-5 pb-8">
          <h3 className="mb-2 text-[13px] font-semibold text-foreground">
            Transactions ({transactions.length})
          </h3>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className={`${HEAD} text-left`}>Date</th>
                <th className={`${HEAD} text-left`}>Type</th>
                <th className={`${HEAD} text-right`}>Shares</th>
                <th className={`${HEAD} text-right`}>Price</th>
                <th className={`${HEAD} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id} className="border-b border-border-soft">
                  <td className={`${CELL} text-left text-dim`}>{shortDate(tx.date)}</td>
                  <td className={`${CELL} text-left text-foreground`}>
                    {TRANSACTION_TYPE_LABELS[tx.type]}
                  </td>
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
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
