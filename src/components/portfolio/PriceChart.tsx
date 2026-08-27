"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { contractMultiplier, type Transaction } from "@/domain/portfolio";
import { money, price as fmtPrice, shares as fmtShares, shortDate } from "@/lib/portfolio/format";

export interface PricePoint {
  date: string;
  close: number;
}

interface Marker {
  /** Y position of the marker, or null on days with no trade — recharts skips nulls. */
  y: number | null;
  /** Dollars traded that day, driving the marker's size. */
  value: number;
}

interface ChartRow {
  /** Position in the series, so the tooltip can reach nearby days. */
  index: number;
  date: string;
  close: number;
  buy: Marker["y"];
  sell: Marker["y"];
  buyValue: number;
  sellValue: number;
  trades: Transaction[];
}

const BUY_TYPES = new Set(["buy", "reinvest", "transfer_in"]);

function isBuy(tx: Transaction): boolean {
  return BUY_TYPES.has(tx.type);
}

/** What a trade actually moved, so the biggest entries read as the biggest marks. */
function tradeValue(tx: Transaction): number {
  if (tx.amount !== null) return Math.abs(tx.amount);
  const multiplier = tx.symbol === null ? 1 : contractMultiplier(tx.symbol);
  return tx.quantity * tx.price * multiplier;
}

/**
 * Snaps trades onto the price series.
 *
 * A trade date won't always be in the series -- a weekend settle date or a
 * holiday. Those attach to the first trading day on or after their date, so a
 * Saturday-settled trade still shows up.
 *
 * A trade from *before* the window is dropped rather than snapped. Snapping it
 * pinned every historical purchase to the left edge, so a one-month chart drew
 * a five-year-old buy as though it had just happened -- and drew it at its
 * original price, well off the scale of the prices around it.
 */
function buildRows(points: readonly PricePoint[], transactions: readonly Transaction[]): ChartRow[] {
  const rows: ChartRow[] = points.map((point, index) => ({
    index,
    date: point.date,
    close: point.close,
    buy: null,
    sell: null,
    buyValue: 0,
    sellValue: 0,
    trades: [],
  }));
  if (rows.length === 0) return rows;

  const indexByDate = new Map(rows.map((row, i) => [row.date, i]));
  const dates = rows.map((row) => row.date);

  for (const tx of transactions) {
    if (tx.date < dates[0]) continue;
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
    if (isBuy(tx)) {
      row.buy = y;
      row.buyValue += tradeValue(tx);
    } else {
      row.sell = y;
      row.sellValue += tradeValue(tx);
    }
  }
  return rows;
}

/**
 * Marker area in px², scaled by what the trade was worth.
 *
 * Square-rooted before scaling so area tracks value rather than radius --
 * radius-scaling makes a trade twice the size look four times as big. Floored
 * well above the old default so the smallest trade is still unmissable, and
 * capped so one outsized entry can't swallow the chart.
 */
function markerSizes(values: readonly number[]): (value: number) => number {
  const largest = Math.max(...values, 0);
  const MIN_AREA = 90;
  const MAX_AREA = 320;
  if (largest <= 0) return () => MIN_AREA;
  return (value: number) =>
    MIN_AREA + (MAX_AREA - MIN_AREA) * Math.min(Math.sqrt(value / largest), 1);
}

/** Chart geometry, needed to turn a pixel hit radius into a number of days. */
const Y_AXIS_WIDTH = 56;
const RIGHT_MARGIN = 12;

/**
 * How far from a marker a hover still counts, in pixels.
 *
 * Sized to the markers themselves -- a large one is about 11px to either side
 * of its centre -- plus a little slack, so pointing at a triangle hits it.
 */
const HIT_RADIUS_PX = 14;

interface MarkerShapeProps {
  cx?: number;
  cy?: number;
  payload?: Record<string, unknown>;
}

/**
 * A trade marker, drawn by hand.
 *
 * Recharts' built-in shapes only point upwards and take a single fixed size, so
 * a buy and a sell came out as the same silhouette at the same scale. Direction
 * is what makes these readable without reference to colour, which is the whole
 * point for anyone who can't separate the green from the red.
 */
function triangleMarker(up: boolean, sizeKey: "buySize" | "sellSize", color: string) {
  function Marker({ cx, cy, payload }: MarkerShapeProps) {
    const area = typeof payload?.[sizeKey] === "number" ? (payload[sizeKey] as number) : 0;
    if (cx == null || cy == null || area <= 0) return null;

    const half = Math.sqrt(area) * 0.62;
    const height = half * 1.7;
    const tip = up ? cy - height / 2 : cy + height / 2;
    const base = up ? cy + height / 2 : cy - height / 2;

    return (
      <polygon
        points={`${cx},${tip} ${cx - half},${base} ${cx + half},${base}`}
        fill={color}
        stroke="var(--panel)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    );
  }
  return Marker;
}

const BuyMarker = triangleMarker(true, "buySize", "var(--buy)");
const SellMarker = triangleMarker(false, "sellSize", "var(--sell)");

/**
 * The nearest trading day carrying a trade, or null if none is close enough.
 *
 * `tradeIndices` is sorted, so this walks in from a binary-search insertion
 * point rather than scanning every day.
 */
export function nearestTradeIndex(
  tradeIndices: readonly number[],
  index: number,
  radius: number,
): number | null {
  if (tradeIndices.length === 0) return null;
  let lo = 0;
  let hi = tradeIndices.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tradeIndices[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  const after = tradeIndices[lo];
  const before = tradeIndices[lo - 1];
  const best =
    after === undefined
      ? before
      : before === undefined || after - index <= index - before
        ? after
        : before;
  return Math.abs(best - index) <= radius ? best : null;
}

/**
 * Trade details on hover, snapping to a trade a few pixels away.
 *
 * Recharts picks the tooltip's row by x-axis category, not by what the cursor
 * is actually over, so on a five-year chart each day is a ~1px target and most
 * trades are unreachable -- the marker is drawn far wider than the day it sits
 * on. Widening the polygon wouldn't help, since the polygons take no part in
 * hovering. So when the hovered day has no trade, we hand back the closest one
 * within roughly a marker's width instead, which is the hit box the markers
 * always looked like they had.
 */
function ChartTooltip({
  active,
  payload,
  rows,
  tradeIndices,
  snapRadius,
}: {
  active?: boolean;
  payload?: { payload: ChartRow }[];
  rows?: readonly ChartRow[];
  tradeIndices?: readonly number[];
  snapRadius?: number;
}) {
  if (!active || !payload?.length) return null;
  const hovered = payload[0].payload;
  const snapped =
    hovered.trades.length > 0 || !rows || !tradeIndices
      ? null
      : nearestTradeIndex(tradeIndices, hovered.index, snapRadius ?? 0);
  const row = rows && snapped !== null ? rows[snapped] : hovered;
  return (
    <div className="rounded-md border border-border bg-panel px-3 py-2 text-[12px] shadow-lg">
      <div className="font-semibold text-foreground">{shortDate(row.date)}</div>
      <div className="text-dim">Close {fmtPrice(row.close)}</div>
      {row.trades.map((tx) => (
        <div key={tx.id} className="mt-0.5 flex items-center gap-1.5">
          <span aria-hidden style={{ color: isBuy(tx) ? "var(--buy)" : "var(--sell)" }}>
            {isBuy(tx) ? "▲" : "▼"}
          </span>
          <span style={{ color: isBuy(tx) ? "var(--buy)" : "var(--sell)" }}>
            {isBuy(tx) ? "Bought" : "Sold"} {fmtShares(tx.quantity)} @ {fmtPrice(tx.price)}
          </span>
          <span className="text-dim-2">({money(tradeValue(tx))})</span>
        </div>
      ))}
    </div>
  );
}

/** Named marks, so the shapes mean something before anything is hovered. */
function Legend() {
  return (
    <div className="flex items-center gap-4 text-[11.5px] text-dim">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-[13px]" style={{ color: "var(--buy)" }}>
          ▲
        </span>
        Buys
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-[13px]" style={{ color: "var(--sell)" }}>
          ▼
        </span>
        Sells
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-0.5 w-4 rounded"
          style={{ backgroundColor: "var(--accent-line)" }}
        />
        Close
      </span>
      <span className="text-dim-2">Marker size follows trade value</span>
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

  const tradeIndices = useMemo(
    () => rows.filter((row) => row.trades.length > 0).map((row) => row.index),
    [rows],
  );

  // The plot's own width, measured rather than assumed: how many days sit under
  // HIT_RADIUS_PX depends entirely on how wide the drawer happens to be.
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setPlotWidth(entry.contentRect.width - Y_AXIS_WIDTH - RIGHT_MARGIN);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const snapRadius = useMemo(() => {
    if (plotWidth <= 0 || rows.length < 2) return 0;
    return Math.max(0, Math.round((HIT_RADIUS_PX * (rows.length - 1)) / plotWidth));
  }, [plotWidth, rows.length]);

  const sizeFor = useMemo(
    () => markerSizes(rows.flatMap((row) => [row.buyValue, row.sellValue].filter((v) => v > 0))),
    [rows],
  );

  const sized = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        buySize: row.buyValue > 0 ? sizeFor(row.buyValue) : 0,
        sellSize: row.sellValue > 0 ? sizeFor(row.sellValue) : 0,
      })),
    [rows, sizeFor],
  );

  /**
   * Tick labels sized to the window. A year-month label is right for a
   * multi-year chart and useless on a one-month one, where every tick reads as
   * the same month; under a year the day is what distinguishes them, and past
   * five years the month stops earning its width.
   */
  const tickFormat = useMemo(() => {
    if (rows.length < 2) return (date: string) => date.slice(0, 7);
    const spanDays =
      (Date.parse(`${rows[rows.length - 1].date}T00:00:00Z`) -
        Date.parse(`${rows[0].date}T00:00:00Z`)) /
      86_400_000;
    if (spanDays <= 400) return (date: string) => date.slice(5).replace("-", "/");
    if (spanDays <= 1900) return (date: string) => date.slice(0, 7);
    return (date: string) => date.slice(0, 4);
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[13px] text-dim">
        No price history available for this symbol.
      </div>
    );
  }

  return (
    <div>
      <div ref={plotRef} className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={sized} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border-soft)" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--color-dim-2)" }}
              tickFormatter={tickFormat}
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
            <Tooltip
              content={
                <ChartTooltip rows={sized} tradeIndices={tradeIndices} snapRadius={snapRadius} />
              }
            />
            <Line
              type="monotone"
              dataKey="close"
              stroke="var(--color-accent-line)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            {/* Drawn after the line so a marker is never buried under it, and
                ringed in the panel colour so two trades days apart stay
                countable instead of merging into one blob. */}
            <Scatter dataKey="buy" shape={BuyMarker} isAnimationActive={false} />
            <Scatter dataKey="sell" shape={SellMarker} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1.5 flex justify-end">
        <Legend />
      </div>
    </div>
  );
}
