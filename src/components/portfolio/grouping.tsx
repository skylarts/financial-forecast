"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Shared grouping machinery for the portfolio tables.
 *
 * Every grouped table here wants the same three things: rows bucketed under a
 * label, the buckets ordered so the money leads, and a header that collapses.
 * Writing that three times meant three slightly different answers to "what does
 * a subtotal include" -- so it lives here once, and each table supplies only the
 * columns its own subtotal row should show.
 */

export interface Group<T> {
  /** Stable identity for React and for collapse state. Distinct from `label`
   *  so two groups that happen to render the same text can't collapse as one. */
  key: string;
  label: string;
  rows: T[];
}

/**
 * Buckets rows under a label, keeping each bucket in the order it arrived --
 * the caller has already sorted, and re-sorting here would silently override
 * whichever column the user clicked.
 *
 * Groups are ordered by `weigh`, largest first, so the biggest holdings sit at
 * the top the way they do when grouping is off. Ties fall back to the label so
 * the order is stable across renders rather than depending on insertion.
 */
export function buildGroups<T>(
  rows: readonly T[],
  labelFor: (row: T) => string,
  weigh: (rows: readonly T[]) => number,
): Group<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const label = labelFor(row);
    const bucket = map.get(label);
    if (bucket) bucket.push(row);
    else map.set(label, [row]);
  }

  return [...map.entries()]
    .map(([label, groupRows]) => ({ key: label, label, rows: groupRows }))
    .sort((a, b) => {
      const difference = weigh(b.rows) - weigh(a.rows);
      return difference !== 0 ? difference : a.label.localeCompare(b.label);
    });
}

export interface CollapseState {
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
  expandAll: () => void;
  collapseAll: (keys: readonly string[]) => void;
  anyCollapsed: boolean;
}

/**
 * Which groups are collapsed, cleared whenever the grouping dimension changes.
 *
 * Without the reset, collapsing "Brokerage" under by-account and then switching
 * to by-class would leave a differently-named group collapsed for no visible
 * reason -- the keys are only meaningful within one dimension.
 */
export function useCollapsedGroups(dimension: string): CollapseState {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [lastDimension, setLastDimension] = useState(dimension);

  // Adjusted during render rather than in an effect: an effect would paint one
  // frame with the previous dimension's collapse state applied to the new
  // groups, which reads as groups randomly collapsing on their own. React
  // re-runs this component immediately on the set, before touching the DOM.
  if (lastDimension !== dimension) {
    setLastDimension(dimension);
    if (collapsed.size > 0) setCollapsed(new Set());
  }

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const collapseAll = useCallback((keys: readonly string[]) => setCollapsed(new Set(keys)), []);

  return useMemo(
    () => ({
      isCollapsed: (key: string) => collapsed.has(key),
      toggle,
      expandAll,
      collapseAll,
      anyCollapsed: collapsed.size > 0,
    }),
    [collapsed, toggle, expandAll, collapseAll],
  );
}

/**
 * A group's header and subtotal row.
 *
 * `cells` are the aggregated figures, one per trailing column, so a subtotal
 * lands directly under the column it totals instead of in a summary sentence
 * the eye has to map back onto the table.
 */
export function GroupHeaderRow({
  label,
  count,
  noun = "position",
  collapsed,
  onToggle,
  labelSpan,
  cells,
}: {
  label: string;
  count: number;
  /** What the rows are, singular. Pluralised by adding an s. */
  noun?: string;
  collapsed: boolean;
  onToggle: () => void;
  /** How many leading columns the label and its toggle span. */
  labelSpan: number;
  /** One node per trailing column, right-aligned. `null` renders an empty cell. */
  cells: readonly React.ReactNode[];
}) {
  return (
    <tr className="border-b border-border bg-panel-2">
      <td colSpan={labelSpan} className="px-3 py-1.5 text-left">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? `Show ${label}` : `Hide ${label}`}
          className="flex items-center gap-1.5 text-[11.5px] font-semibold text-dim transition-colors hover:text-foreground"
        >
          <span
            aria-hidden
            className={`inline-block text-[9px] text-dim-2 transition-transform ${
              collapsed ? "" : "rotate-90"
            }`}
          >
            ▶
          </span>
          {label}
          <span className="font-normal text-dim-2">
            {count} {count === 1 ? noun : `${noun}s`}
          </span>
        </button>
      </td>
      {cells.map((cell, i) => (
        <td
          // Positional by nature: these are columns, not entities, and they
          // never reorder within a table.
          key={i}
          className="px-3 py-1.5 text-right text-[11.5px] font-semibold tabular-nums"
        >
          {cell}
        </td>
      ))}
    </tr>
  );
}

/** Expand-all / collapse-all pair, shown next to a table's grouping control. */
export function GroupToggles({
  groupKeys,
  collapse,
}: {
  groupKeys: readonly string[];
  collapse: CollapseState;
}) {
  return (
    <button
      type="button"
      onClick={() => (collapse.anyCollapsed ? collapse.expandAll() : collapse.collapseAll(groupKeys))}
      className="text-[11.5px] text-dim-2 underline transition-colors hover:text-foreground"
    >
      {collapse.anyCollapsed ? "Expand all" : "Collapse all"}
    </button>
  );
}
