"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Transaction } from "@/domain/portfolio";
import { price as fmtPrice, shares as fmtShares, shortDate } from "@/lib/portfolio/format";

export interface PricePoint {
  date: string;
  close: number;
}

interface ChartRow {
  date: string;
  close: number;
  /** Y position of the marker, or null on days with no trade — recharts skips nulls. */
  buy: number | null;
  sell: number | null;
  trades: Transaction[];
}

const BUY_COLOR = "var(--color-positive)";
const SELL_COLOR = "var(--color-negative)";

/**
 * Snaps trades onto the price series.
 *
 * A trade date won't always be in the series -- a weekend settle date, a
 * holiday, or a history that starts after the purchase. Rather than drop those
 * markers, each trade attaches to the first trading day on or after its date,
 * so every trade stays visible somewhere honest on the timeline.
 */
function buildRows(points: readonly PricePoint[], transactions: readonly Transaction[]): ChartRow[] {
  const rows: ChartRow[] = points.map((point) => ({
    date: point.date,
    close: point.close,
    buy: null,
    sell: null,
    trades: [],
  }));
  if (rows.length === 0) return rows;

  const indexByDate = new Map(rows.map((row, i) => [row.date, i]));
  const dates = rows.map((row) => row.date);

  for (const tx of transactions) {
    let index = indexByDate.get(tx.date);
    if (index === undefined) {
      const next = dates.findIndex((date) => date >= tx.date);
      if (next === -1) continue;
      index = next;
    }
    const row = rows[index];
    row.trades.push(tx);
    // Sit the marker at the executed price when there is one, so the dot shows
    // where the trade actually landed rather than where the day happened to close.
    const y = tx.price > 0 ? tx.price : row.close;
    const isBuy = tx.type === "buy" || tx.type === "reinvest" || tx.type === "transfer_in";
    if (isBuy) row.buy = y;
    else row.sell = y;
  }
  return rows;
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-panel px-3 py-2 text-[12px] shadow-lg">
      <div className="font-semibold text-foreground">{shortDate(row.date)}</div>
      <div className="text-dim">Close {fmtPrice(row.close)}</div>
      {row.trades.map((tx) => {
        const isBuy = tx.type === "buy" || tx.type === "reinvest" || tx.type === "transfer_in";
        return (
          <div key={tx.id} className={isBuy ? "text-positive" : "text-negative"}>
            {isBuy ? "Bought" : "Sold"} {fmtShares(tx.quantity)} @ {fmtPrice(tx.price)}
          </div>
        );
      })}
    </div>
  );
}

export function PriceChart({
  points,
  transactions,
}: {
  points: readonly PricePoint[];
  transactions: readonly Transaction[];
}) {
  const rows = useMemo(() => buildRows(points, transactions), [points, transactions]);

  if (rows.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[13px] text-dim">
        No price history available for this symbol.
      </div>
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-border-soft)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "var(--color-dim-2)" }}
            tickFormatter={(date: string) => date.slice(0, 7)}
            minTickGap={48}
            stroke="var(--color-border)"
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-dim-2)" }}
            tickFormatter={(value: number) => `$${Math.round(value)}`}
            width={56}
            domain={["auto", "auto"]}
            stroke="var(--color-border)"
          />
          <Tooltip content={<ChartTooltip />} />
          <Line
            type="monotone"
            dataKey="close"
            stroke="var(--color-accent-line)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Scatter dataKey="buy" fill={BUY_COLOR} shape="circle" isAnimationActive={false} />
          <Scatter dataKey="sell" fill={SELL_COLOR} shape="triangle" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
