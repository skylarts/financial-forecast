"use client";

import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import {
  ASSET_CLASS_LABELS,
  PORTFOLIO_ACCOUNT_TYPE_LABELS,
  type AssetClass,
  type PortfolioAccount,
} from "@/domain/portfolio";
import type { Person } from "@/domain/household";
import { buildAllocation, type AllocationSlice, type Holding } from "@/engine/portfolio/metrics";
import { money } from "@/lib/portfolio/format";
import { ownerLabel } from "@/lib/people";
import { Segmented } from "@/components/ui/controls";

const DIMENSIONS = [
  { value: "assetClass", label: "Asset class" },
  { value: "account", label: "Account" },
  { value: "owner", label: "Person" },
  { value: "symbol", label: "Holding" },
  { value: "accountType", label: "Account type" },
  { value: "side", label: "Side" },
] as const;

export type AllocationDimension = (typeof DIMENSIONS)[number]["value"];

/**
 * Slots in the ring before the tail folds into "Other".
 *
 * Eight is where the categorical palette stops: past it a chart would have to
 * invent hues, and two hues that close together stop encoding anything. A
 * portfolio of forty positions has a shape worth seeing, and it isn't forty
 * indistinguishable slivers.
 */
const MAX_SLICES = 8;
const OTHER_LABEL = "Other";

const SERIES_COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
];

/**
 * Colour follows the slice's identity, fixed by its rank in the *unfiltered*
 * ordering, so toggling cash off doesn't repaint every slice that survives.
 */
function colorFor(index: number, label: string): string {
  if (label === OTHER_LABEL) return "var(--series-other)";
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

/** Folds everything past the palette into one honest remainder. */
function withOther(slices: AllocationSlice[]): AllocationSlice[] {
  if (slices.length <= MAX_SLICES) return slices;
  const head = slices.slice(0, MAX_SLICES);
  const tail = slices.slice(MAX_SLICES);
  return [
    ...head,
    {
      label: OTHER_LABEL,
      value: tail.reduce((sum, s) => sum + s.value, 0),
      weight: tail.reduce((sum, s) => sum + s.weight, 0),
    },
  ];
}

function SliceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: AllocationSlice }[];
}) {
  if (!active || !payload?.length) return null;
  const slice = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-panel px-3 py-2 text-[12px] shadow-lg">
      <div className="font-semibold text-foreground">{slice.label}</div>
      <div className="tabular-nums text-dim">
        {money(slice.value)} · {(slice.weight * 100).toFixed(1)}%
      </div>
    </div>
  );
}

/**
 * The precise readout beside the ring.
 *
 * The ring shows shape; this shows numbers. It is also what discharges the
 * palette's light-mode contrast warning -- three of the eight hues sit under
 * 3:1 on a cream surface, so identity is never left to colour alone.
 */
function AllocationBars({
  slices,
  onSelect,
}: {
  slices: AllocationSlice[];
  onSelect?: (label: string) => void;
}) {
  if (slices.length === 0) {
    return <p className="text-[12.5px] text-dim">Nothing to show yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      {slices.map((slice, i) => {
        const clickable = onSelect && slice.label !== OTHER_LABEL;
        return (
          <div
            key={slice.label}
            onClick={clickable ? () => onSelect(slice.label) : undefined}
            className={`flex items-center gap-3 rounded px-1 py-0.5 ${
              clickable ? "cursor-pointer hover:bg-panel-2" : ""
            }`}
            title={clickable ? `Show ${slice.label} in Holdings` : undefined}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: colorFor(i, slice.label) }}
            />
            <div className="w-40 shrink-0 truncate text-[12px] text-dim">{slice.label}</div>
            <div className="h-3 flex-1 overflow-hidden rounded-sm bg-panel-2">
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${Math.max(slice.weight * 100, 0.5)}%`,
                  backgroundColor: colorFor(i, slice.label),
                }}
              />
            </div>
            <div className="w-16 shrink-0 text-right text-[12px] tabular-nums text-dim">
              {(slice.weight * 100).toFixed(1)}%
            </div>
            <div className="w-24 shrink-0 text-right text-[12px] tabular-nums text-foreground">
              {money(slice.value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AllocationPanel({
  holdings,
  accounts,
  accountNames,
  people,
  onDrillDown,
  children,
}: {
  holdings: Holding[];
  accounts: PortfolioAccount[];
  accountNames: Map<string, string>;
  people: readonly Person[];
  /** Sends a slice through to the holdings view as a filter. */
  onDrillDown: (dimension: AllocationDimension, label: string) => void;
  /** The classify-holdings controls, which live below the charts. */
  children?: React.ReactNode;
}) {
  const [dimension, setDimension] = useState<AllocationDimension>("assetClass");
  const [includeCash, setIncludeCash] = useState(true);

  const accountTypes = useMemo(
    () => new Map(accounts.map((a) => [a.id, PORTFOLIO_ACCOUNT_TYPE_LABELS[a.type]])),
    [accounts],
  );
  const accountOwners = useMemo(
    () => new Map(accounts.map((a) => [a.id, ownerLabel(people, a.ownerId)])),
    [accounts, people],
  );

  const slices = useMemo(() => {
    const pick = (h: Holding): string => {
      switch (dimension) {
        case "assetClass":
          return ASSET_CLASS_LABELS[h.assetClass as AssetClass] ?? h.assetClass;
        case "account":
          return accountNames.get(h.accountId) ?? "Unknown account";
        case "owner":
          return accountOwners.get(h.accountId) ?? "Joint";
        case "symbol":
          return h.kind === "cash" ? "Cash" : h.symbol;
        case "accountType":
          return accountTypes.get(h.accountId) ?? "Unknown";
        case "side":
          // Cash isn't a bet in either direction, so it says so rather than
          // padding the long side with money that isn't invested.
          return h.kind === "cash" ? "Cash" : h.side === "short" ? "Short" : "Long";
      }
    };
    return withOther(buildAllocation(holdings, pick, { includeCash }));
  }, [holdings, dimension, includeCash, accountNames, accountTypes, accountOwners]);

  const hasCash = useMemo(() => holdings.some((h) => h.kind === "cash"), [holdings]);
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  // A short's negative value would sweep an entire wedge below zero, and a ring
  // cannot draw a negative angle -- it silently renders as nothing, or worse, as
  // a wrong-sized positive one. The bars handle signed values honestly; the ring
  // steps aside and says why.
  const hasNegativeSlice = slices.some((s) => s.value < 0);

  const drillLabel = (label: string) => {
    if (label === OTHER_LABEL || label === "Cash") return;
    onDrillDown(dimension, label);
  };

  return (
    <div className="space-y-6 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={DIMENSIONS}
          value={dimension}
          onChange={setDimension}
          size="sm"
          ariaLabel="Break allocation down by"
        />
        {hasCash && (
          <label className="flex items-center gap-1.5 text-[12px] text-dim">
            <input
              type="checkbox"
              checked={!includeCash}
              onChange={(e) => setIncludeCash(!e.target.checked)}
            />
            Exclude cash
            <span
              title="Off, percentages are of everything you own. On, they're of the money you have invested."
              className="cursor-help text-dim-2"
            >
              ⓘ
            </span>
          </label>
        )}
        <span className="ml-auto text-[11.5px] tabular-nums text-dim-2">
          {money(total)} across {slices.length} {slices.length === 1 ? "slice" : "slices"}
        </span>
      </div>

      {slices.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">
          Nothing to allocate yet. Import a transaction history or add a buy.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="h-[280px]">
            {hasNegativeSlice ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-[12.5px] text-dim">
                A short position makes this breakdown net negative, which a ring
                can&apos;t draw. The figures beside it still add up.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices}
                    dataKey="value"
                    nameKey="label"
                    innerRadius="58%"
                    outerRadius="88%"
                    // A gap plus a surface-coloured ring keeps neighbouring
                    // slices legible even where two hues sit close together.
                    paddingAngle={1.5}
                    stroke="var(--panel)"
                    strokeWidth={2}
                    isAnimationActive={false}
                    onClick={(entry: unknown) => {
                      const slice = entry as { label?: string };
                      if (slice.label) drillLabel(slice.label);
                    }}
                  >
                    {slices.map((slice, i) => (
                      <Cell
                        key={slice.label}
                        fill={colorFor(i, slice.label)}
                        className={slice.label === OTHER_LABEL ? "" : "cursor-pointer"}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<SliceTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <AllocationBars slices={slices} onSelect={drillLabel} />
        </div>
      )}

      {children}
    </div>
  );
}
