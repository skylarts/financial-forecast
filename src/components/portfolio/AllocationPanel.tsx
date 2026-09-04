"use client";

import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import {
  ASSET_CLASS_LABELS,
  assetClassSchema,
  basketBySymbol,
  INSTRUMENT_TYPE_LABELS,
  instrumentTypeSchema,
  PORTFOLIO_ACCOUNT_TYPE_LABELS,
  type AssetClass,
  type Basket,
  type PortfolioAccount,
} from "@/domain/portfolio";
import type { Person } from "@/domain/household";
import {
  buildAllocation,
  buildBasketAllocation,
  buildThemeAllocation,
  explodeExposures,
  type AllocationSlice,
  type Holding,
} from "@/engine/portfolio/metrics";
import { money } from "@/lib/portfolio/format";
import { ownerLabel } from "@/lib/people";
import { holdingFacetsActive, matchesHoldingFacets, type HoldingFacets } from "./filters";

const DIMENSIONS = [
  { value: "assetClass", label: "Asset class" },
  { value: "theme", label: "Theme" },
  { value: "instrumentType", label: "Type" },
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

/**
 * Shades for the members of an opened basket.
 *
 * They read as variations of the basket's own colour rather than as eight
 * fresh hues, which is the whole point of opening one: these are the parts of
 * something, not new top-level slices competing with it. The first member
 * keeps the basket's colour exactly, so the wedge that was there a moment ago
 * is still recognisable; the rest fade toward the surface, never far enough to
 * disappear into it.
 */
function memberColor(base: string, index: number, count: number): string {
  if (index === 0 || count < 2) return base;
  const strength = 100 - Math.round((index / count) * 55);
  return `color-mix(in srgb, ${base} ${strength}%, var(--panel))`;
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
      {slice.members && (
        <div className="mt-0.5 text-[11px] text-dim-2">
          {slice.members.length} holdings — click to open
        </div>
      )}
    </div>
  );
}

/** A slice paired with the colour it is drawn in, so the ring and the bars
 *  can't disagree about which hue means which name. */
interface ColoredSlice {
  slice: AllocationSlice;
  color: string;
}

/**
 * One line of the readout. Shared by top-level slices and by the members of an
 * opened basket, which differ only in indentation and what a click does.
 */
function AllocationBar({
  slice,
  color,
  indented,
  onClick,
  title,
  lead,
  note,
}: {
  slice: AllocationSlice;
  color: string;
  indented?: boolean;
  onClick?: () => void;
  title?: string;
  /** The disclosure triangle on a basket; a spacer keeps everything else in
   *  the same column whether or not any basket is on screen. */
  lead?: React.ReactNode;
  /** A quiet aside after the label, e.g. how many holdings a basket holds. */
  note?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3 rounded px-1 py-0.5 ${onClick ? "cursor-pointer hover:bg-panel-2" : ""} ${
        indented ? "pl-5" : ""
      }`}
      title={title}
    >
      {lead ?? null}
      <span
        aria-hidden
        className={`shrink-0 rounded-sm ${indented ? "h-2 w-2" : "h-2.5 w-2.5"}`}
        style={{ backgroundColor: color }}
      />
      {/* The label takes whatever room is left on a phone; from `sm` up
          it goes back to a fixed column so the bars line up with each
          other. */}
      <div
        className={`min-w-0 flex-1 truncate text-[12px] sm:flex-none ${
          indented ? "text-dim-2 sm:w-[140px]" : "text-dim sm:w-40"
        }`}
      >
        {slice.label}
        {note && <span className="ml-1.5 text-[10.5px] text-dim-2">{note}</span>}
      </div>
      {/* The proportion bar is the first thing to go on a narrow screen.
          Label, percentage and dollar value together already overran the
          width, and the donut directly above says the same thing -- so
          the bar is the redundant one, not the number it was clipping. */}
      <div className="hidden h-3 flex-1 overflow-hidden rounded-sm bg-panel-2 sm:block">
        <div
          className="h-full rounded-sm"
          style={{
            width: `${Math.max(slice.weight * 100, 0.5)}%`,
            backgroundColor: color,
          }}
        />
      </div>
      <div className="w-12 shrink-0 text-right text-[12px] tabular-nums text-dim sm:w-16">
        {(slice.weight * 100).toFixed(1)}%
      </div>
      <div className="shrink-0 text-right text-[12px] tabular-nums text-foreground sm:w-24">
        {money(slice.value)}
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
  rows,
  expanded,
  onToggle,
  onSelect,
  titleFor,
}: {
  rows: ColoredSlice[];
  /** Labels of the baskets currently opened up. */
  expanded: ReadonlySet<string>;
  onToggle: (label: string) => void;
  onSelect?: (label: string) => void;
  /** What clicking a slice does, for the tooltip -- narrows this same
   *  breakdown for class and theme, jumps to Holdings for everything else. */
  titleFor: (label: string) => string;
}) {
  if (rows.length === 0) {
    return <p className="text-[12.5px] text-dim">Nothing to show yet.</p>;
  }
  const anyBaskets = rows.some(({ slice }) => slice.members);
  return (
    <div className="space-y-1.5">
      {rows.map(({ slice, color }) => {
        const members = slice.members;
        if (!members) {
          return (
            <AllocationBar
              key={slice.label}
              slice={slice}
              color={color}
              onClick={onSelect ? () => onSelect(slice.label) : undefined}
              title={onSelect ? titleFor(slice.label) : undefined}
              // Keeps an ordinary slice's swatch in the same column as a
              // basket's, so the triangles read as a property of two rows
              // rather than knocking the whole list out of alignment.
              lead={anyBaskets ? <span aria-hidden className="w-3 shrink-0" /> : undefined}
            />
          );
        }
        const open = expanded.has(slice.label);
        return (
          <div key={slice.label} className={open ? "rounded bg-panel-2/40 pb-1" : undefined}>
            <AllocationBar
              slice={slice}
              color={color}
              onClick={() => onToggle(slice.label)}
              title={open ? `Close ${slice.label}` : `See what makes up ${slice.label}`}
              note={`${members.length} holding${members.length === 1 ? "" : "s"}`}
              lead={
                <span
                  aria-hidden
                  className={`w-3 shrink-0 text-[9px] text-dim-2 transition-transform ${open ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
              }
            />
            {open &&
              members.map((member, j) => (
                <AllocationBar
                  key={member.label}
                  slice={member}
                  color={memberColor(color, j, members.length)}
                  indented
                  onClick={onSelect ? () => onSelect(member.label) : undefined}
                  title={`Open ${member.label} — ${(
                    (slice.value > 0 ? member.value / slice.value : 0) * 100
                  ).toFixed(1)}% of ${slice.label}`}
                />
              ))}
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
  baskets,
  facets,
  onFacetsChange,
  onDrillDown,
  onSelectSymbol,
  children,
}: {
  holdings: Holding[];
  accounts: PortfolioAccount[];
  accountNames: Map<string, string>;
  people: readonly Person[];
  /** Groups of holdings treated as one position, which stand in for their
   *  members in the by-holding breakdown. */
  baskets: readonly Basket[];
  /** Owned by the shared filter bar above the tabs, so a class picked here
   *  is still picked on Performance and Holdings. */
  facets: HoldingFacets;
  onFacetsChange: (update: (current: HoldingFacets) => HoldingFacets) => void;
  /** Sends a slice through to the holdings view as a filter. */
  onDrillDown: (dimension: AllocationDimension, label: string) => void;
  /** Opens the detail drawer on one name, for a slice of the by-holding ring. */
  onSelectSymbol: (symbol: string) => void;
  /** The classify-holdings controls, which live below the charts. */
  children?: React.ReactNode;
}) {
  const [dimension, setDimension] = useState<AllocationDimension>("assetClass");
  const [includeCash, setIncludeCash] = useState(true);
  /** Baskets opened up to show their parts, by name. */
  const [openBaskets, setOpenBaskets] = useState<ReadonlySet<string>>(() => new Set());

  const toggleBasket = (label: string) =>
    setOpenBaskets((current) => {
      const next = new Set(current);
      if (!next.delete(label)) next.add(label);
      return next;
    });

  const accountTypes = useMemo(
    () => new Map(accounts.map((a) => [a.id, PORTFOLIO_ACCOUNT_TYPE_LABELS[a.type]])),
    [accounts],
  );
  const accountOwners = useMemo(
    () => new Map(accounts.map((a) => [a.id, ownerLabel(people, a.ownerId)])),
    [accounts, people],
  );

  const basketOf = useMemo(() => basketBySymbol(baskets), [baskets]);

  const filtersActive = holdingFacetsActive(facets);
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
    // Baskets replace their members here and nowhere else: they are a claim
    // about which *holdings* are really one position, so they have nothing to
    // say about how those holdings split by class, account or owner.
    if (dimension === "symbol") {
      return buildBasketAllocation(holdings, (symbol) => basketOf.get(symbol) ?? null, { includeCash });
    }

    const pick = (h: Holding): string => {
      switch (dimension) {
        case "account":
          return accountNames.get(h.accountId) ?? "Unknown account";
        case "owner":
          return accountOwners.get(h.accountId) ?? "Joint";
        case "accountType":
          return accountTypes.get(h.accountId) ?? "Unknown";
        case "instrumentType":
          return INSTRUMENT_TYPE_LABELS[h.instrumentType] ?? h.instrumentType;
        case "side":
          // Cash isn't a bet in either direction, so it says so rather than
          // padding the long side with money that isn't invested.
          return h.kind === "cash" ? "Cash" : h.side === "short" ? "Short" : "Long";
      }
    };
    return buildAllocation(holdings, pick, { includeCash });
  }, [filteredHoldings, dimension, includeCash, accountNames, accountTypes, accountOwners, basketOf]);

  const hasCash = useMemo(() => filteredHoldings.some((h) => h.kind === "cash"), [filteredHoldings]);
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  /** Colour is assigned once, here, and both the ring and the bars read it
   *  from the same place. */
  const rows = useMemo<ColoredSlice[]>(
    () => slices.map((slice, i) => ({ slice, color: colorFor(i) })),
    [slices],
  );

  /**
   * What the ring actually draws. An opened basket gives up its single wedge
   * to its members, in shades of the colour it had -- so opening one splits a
   * wedge in place instead of rearranging the whole ring around it.
   */
  const chartData = useMemo(
    () =>
      rows.flatMap(({ slice, color }) =>
        slice.members && openBaskets.has(slice.label)
          ? slice.members.map((member, j) => ({
              ...member,
              color: memberColor(color, j, slice.members!.length),
              isBasket: false,
            }))
          : [{ ...slice, color, isBasket: Boolean(slice.members) }],
      ),
    [rows, openBaskets],
  );

  // A short's negative value would sweep an entire wedge below zero, and a ring
  // cannot draw a negative angle -- it silently renders as nothing, or worse, as
  // a wrong-sized positive one. The bars handle signed values honestly; the ring
  // steps aside and says why. Read off what is drawn, not off `slices`: a
  // basket can net positive over a short held inside it.
  const hasNegativeSlice = chartData.some((s) => s.value < 0);

  /**
   * Clicking a class, theme, or type slice narrows this same view rather than
   * jumping to Holdings -- those three facets live here now, so drilling into
   * one means seeing the rest of the breakdown recompute for just that
   * slice, not leaving to a different tab to read it.
   */
  const drillLabel = (label: string) => {
    if (label === "Cash") return;
    if (dimension === "assetClass") {
      const match = assetClassSchema.options.find((cls) => ASSET_CLASS_LABELS[cls] === label);
      if (match) onFacetsChange((f) => ({ ...f, assetClass: { mode: "include", selected: new Set([match]) } }));
      return;
    }
    if (dimension === "theme") {
      onFacetsChange((f) => ({ ...f, theme: { mode: "include", selected: new Set([label]) } }));
      return;
    }
    // A holding slice is a name, and a name has a detail panel -- no reason to
    // send it to Holdings and make the reader find the row.
    if (dimension === "symbol") {
      onSelectSymbol(label);
      return;
    }
    if (dimension === "instrumentType") {
      const match = instrumentTypeSchema.options.find((t) => INSTRUMENT_TYPE_LABELS[t] === label);
      if (match) onFacetsChange((f) => ({ ...f, instrumentType: { mode: "include", selected: new Set([match]) } }));
      return;
    }
    onDrillDown(dimension, label);
  };

  return (
    <div className="space-y-6 px-3 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        {/* Seven segments made this the widest control in the app, and the
            labels are long enough that the strip wrapped on a narrow window.
            A select says the same thing in a quarter of the space. */}
        <select
          value={dimension}
          onChange={(e) => setDimension(e.target.value as AllocationDimension)}
          aria-label="Break allocation down by"
          className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground"
        >
          {DIMENSIONS.map((d) => (
            <option key={d.value} value={d.value}>
              By {d.label.toLowerCase()}
            </option>
          ))}
        </select>
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
        {/* `ml-auto` alone made this wrap onto its own line and sit hard
            right, reading as a stray fragment; on a phone it lines up under
            the controls it describes instead. */}
        <span className="w-full text-[11.5px] tabular-nums text-dim-2 sm:ml-auto sm:w-auto sm:text-right">
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
        <div className="grid gap-6 rounded-lg border border-border bg-panel p-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
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
                    data={chartData}
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
                      const slice = entry as { label?: string; isBasket?: boolean };
                      if (!slice.label) return;
                      if (slice.isBasket) toggleBasket(slice.label);
                      else drillLabel(slice.label);
                    }}
                  >
                    {chartData.map((slice) => (
                      <Cell key={slice.label} fill={slice.color} className="cursor-pointer" />
                    ))}
                  </Pie>
                  <Tooltip content={<SliceTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="h-[280px] overflow-y-auto pr-1">
            <AllocationBars
              rows={rows}
              expanded={openBaskets}
              onToggle={toggleBasket}
              onSelect={drillLabel}
              titleFor={(label) =>
                dimension === "assetClass" || dimension === "theme" || dimension === "instrumentType"
                  ? `Filter this breakdown to ${label}`
                  : dimension === "symbol"
                    ? `Open ${label}`
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
