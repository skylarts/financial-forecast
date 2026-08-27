"use client";

import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import {
  ASSET_CLASS_LABELS,
  assetClassSchema,
  PORTFOLIO_ACCOUNT_TYPE_LABELS,
  type AssetClass,
  type PortfolioAccount,
} from "@/domain/portfolio";
import type { Person } from "@/domain/household";
import {
  buildAllocation,
  buildThemeAllocation,
  explodeExposures,
  type AllocationSlice,
  type Holding,
} from "@/engine/portfolio/metrics";
import { money } from "@/lib/portfolio/format";
import { ownerLabel } from "@/lib/people";
import { Segmented } from "@/components/ui/controls";
import { FacetMenu } from "@/components/ui/FacetMenu";
import {
  assetClassFacetOptions,
  emptyHoldingFacets,
  holdingFacetsActive,
  instrumentTypeFacetOptions,
  matchesHoldingFacets,
  themeFacetOptions,
  type HoldingFacets,
} from "./filters";

const DIMENSIONS = [
  { value: "assetClass", label: "Asset class" },
  { value: "theme", label: "Theme" },
  { value: "account", label: "Account" },
  { value: "owner", label: "Person" },
  { value: "symbol", label: "Holding" },
  { value: "accountType", label: "Account type" },
  { value: "side", label: "Side" },
] as const;

export type AllocationDimension = (typeof DIMENSIONS)[number]["value"];

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
 * Past the eight-hue palette, colours repeat -- with a portfolio's worth of
 * holdings on screen, identity mostly reads from the label anyway.
 */
function colorFor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
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
  titleFor,
}: {
  slices: AllocationSlice[];
  onSelect?: (label: string) => void;
  /** What clicking a slice does, for the tooltip -- narrows this same
   *  breakdown for class and theme, jumps to Holdings for everything else. */
  titleFor: (label: string) => string;
}) {
  if (slices.length === 0) {
    return <p className="text-[12.5px] text-dim">Nothing to show yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      {slices.map((slice, i) => {
        const clickable = onSelect;
        return (
          <div
            key={slice.label}
            onClick={clickable ? () => onSelect(slice.label) : undefined}
            className={`flex items-center gap-3 rounded px-1 py-0.5 ${
              clickable ? "cursor-pointer hover:bg-panel-2" : ""
            }`}
            title={clickable ? titleFor(slice.label) : undefined}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: colorFor(i) }}
            />
            <div className="w-40 shrink-0 truncate text-[12px] text-dim">{slice.label}</div>
            <div className="h-3 flex-1 overflow-hidden rounded-sm bg-panel-2">
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${Math.max(slice.weight * 100, 0.5)}%`,
                  backgroundColor: colorFor(i),
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
  const [facets, setFacets] = useState<HoldingFacets>(emptyHoldingFacets());

  const accountTypes = useMemo(
    () => new Map(accounts.map((a) => [a.id, PORTFOLIO_ACCOUNT_TYPE_LABELS[a.type]])),
    [accounts],
  );
  const accountOwners = useMemo(
    () => new Map(accounts.map((a) => [a.id, ownerLabel(people, a.ownerId)])),
    [accounts, people],
  );

  const filtersActive = holdingFacetsActive(facets);
  const assetClassOptions = useMemo(() => assetClassFacetOptions(holdings, facets), [holdings, facets]);
  const themeOptions = useMemo(() => themeFacetOptions(holdings, facets), [holdings, facets]);
  const instrumentTypeOptions = useMemo(
    () => instrumentTypeFacetOptions(holdings, facets),
    [holdings, facets],
  );
  const filteredHoldings = useMemo(
    () => (filtersActive ? holdings.filter((h) => matchesHoldingFacets(h, facets)) : holdings),
    [holdings, facets, filtersActive],
  );

  const slices = useMemo(() => {
    const holdings = filteredHoldings;
    // A fund that spans classes splits its dollars across each one it
    // touches, so this dimension runs over exploded rows rather than picking
    // one label per holding the way every other dimension does.
    if (dimension === "assetClass") {
      return buildAllocation(
        explodeExposures(holdings),
        (h) => ASSET_CLASS_LABELS[h.assetClass as AssetClass] ?? h.assetClass,
        { includeCash },
      );
    }
    // Theme tags overlap rather than partition, so this one skips `pick`
    // entirely -- a holding tagged twice belongs in two slices at its full
    // value, which `buildAllocation`'s one-label-per-row model can't express.
    if (dimension === "theme") {
      return buildThemeAllocation(holdings, { includeCash });
    }

    const pick = (h: Holding): string => {
      switch (dimension) {
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
    return buildAllocation(holdings, pick, { includeCash });
  }, [filteredHoldings, dimension, includeCash, accountNames, accountTypes, accountOwners]);

  const hasCash = useMemo(() => filteredHoldings.some((h) => h.kind === "cash"), [filteredHoldings]);
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  // A short's negative value would sweep an entire wedge below zero, and a ring
  // cannot draw a negative angle -- it silently renders as nothing, or worse, as
  // a wrong-sized positive one. The bars handle signed values honestly; the ring
  // steps aside and says why.
  const hasNegativeSlice = slices.some((s) => s.value < 0);

  /**
   * Clicking a class or theme slice narrows this same view rather than
   * jumping to Holdings -- those two facets live here now, so drilling into
   * one means seeing the rest of the breakdown recompute for just that
   * slice, not leaving to a different tab to read it.
   */
  const drillLabel = (label: string) => {
    if (label === "Cash") return;
    if (dimension === "assetClass") {
      const match = assetClassSchema.options.find((cls) => ASSET_CLASS_LABELS[cls] === label);
      if (match) setFacets((f) => ({ ...f, assetClass: { mode: "include", selected: new Set([match]) } }));
      return;
    }
    if (dimension === "theme") {
      setFacets((f) => ({ ...f, theme: { mode: "include", selected: new Set([label]) } }));
      return;
    }
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
        <FacetMenu
          label="Class"
          options={assetClassOptions}
          state={facets.assetClass}
          onChange={(next) => setFacets((f) => ({ ...f, assetClass: next }))}
        />
        <FacetMenu
          label="Theme"
          options={themeOptions}
          state={facets.theme}
          onChange={(next) => setFacets((f) => ({ ...f, theme: next }))}
        />
        <FacetMenu
          label="Type"
          options={instrumentTypeOptions}
          state={facets.instrumentType}
          onChange={(next) => setFacets((f) => ({ ...f, instrumentType: next }))}
        />
        {filtersActive && (
          <button
            type="button"
            onClick={() => setFacets(emptyHoldingFacets())}
            className="text-[11.5px] text-dim-2 underline hover:text-foreground"
          >
            Clear filters
          </button>
        )}
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
          {dimension === "theme" ? (
            <span title="A holding tagged more than once counts at full value in each of its tags, so these slices can add up to more than your total.">
              {slices.length} theme{slices.length === 1 ? "" : "s"}, tags can overlap
            </span>
          ) : (
            <>
              {money(total)} across {slices.length} {slices.length === 1 ? "slice" : "slices"}
            </>
          )}
        </span>
      </div>

      {slices.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">
          {filtersActive
            ? "No holdings match those filters."
            : "Nothing to allocate yet. Import a transaction history or add a buy."}
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="h-[280px]">
            {dimension === "theme" ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-[12.5px] text-dim">
                Tags overlap, so a ring -- which only ever draws a whole circle --
                can&apos;t represent them. The bars beside it read independently instead.
              </div>
            ) : hasNegativeSlice ? (
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
                      <Cell key={slice.label} fill={colorFor(i)} className="cursor-pointer" />
                    ))}
                  </Pie>
                  <Tooltip content={<SliceTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="h-[280px] overflow-y-auto pr-1">
            <AllocationBars
              slices={slices}
              onSelect={drillLabel}
              titleFor={(label) =>
                dimension === "assetClass" || dimension === "theme"
                  ? `Filter this breakdown to ${label}`
                  : `Show ${label} in Holdings`
              }
            />
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
