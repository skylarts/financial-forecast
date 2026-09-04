"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
 * Groups themselves are ordered by where their first row lands in that same
 * sorted input, not by a fixed metric like total value -- a `Map`'s keys
 * iterate in insertion order, so the group holding the topmost row surfaces
 * first automatically. That's what makes a click on any column, money or not,
 * visibly reorder a grouped table: the old fixed weighting only ever
 * responded to the columns it happened to be computed from.
 */
export function buildGroups<T>(rows: readonly T[], labelFor: (row: T) => string): Group<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const label = labelFor(row);
    const bucket = map.get(label);
    if (bucket) bucket.push(row);
    else map.set(label, [row]);
  }

  return [...map.entries()].map(([label, groupRows]) => ({ key: label, label, rows: groupRows }));
}

/**
 * Reorders groups by their own subtotal of whatever column is being sorted on.
 *
 * First-row order is a fair proxy while every row's money belongs to exactly
 * one group, but grouping by asset class hands each group only a slice of a
 * multi-class fund: the group that happens to hold the top row can easily be
 * the smaller pile of money. Ranking by the subtotal is what "sorted by value"
 * means once the value is divided.
 *
 * Only meaningful for columns that add up -- ranking groups by a summed price
 * or a summed percentage would be arithmetic on nothing -- so callers pass
 * `total` only for those and leave the rest in first-row order.
 */
export function orderGroupsBy<T>(
  groups: readonly Group<T>[],
  total: (rows: readonly T[]) => number,
  direction: "asc" | "desc",
): Group<T>[] {
  const factor = direction === "asc" ? 1 : -1;
  return groups
    .map((group) => ({ group, rank: total(group.rows) }))
    .sort((a, b) => (a.rank - b.rank) * factor)
    .map((entry) => entry.group);
}

export interface CollapseState {
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  /** Every group open, with nothing toggled since. */
  allExpanded: boolean;
  /** Every group shut, with nothing toggled since. */
  allCollapsed: boolean;
}

/**
 * Which groups are collapsed, cleared whenever the grouping dimension changes.
 *
 * Held as a default plus the groups that depart from it, rather than as the set
 * of collapsed keys: a table that opens collapsed has to answer "is this group
 * shut" for keys that don't exist yet when the dimension is picked, and a set
 * of keys can only ever answer no.
 *
 * The reset on a dimension change matters for the same reason it always did --
 * collapsing "Brokerage" under by-account and then switching to by-class would
 * otherwise leave a differently-named group collapsed for no visible reason.
 */
export function useCollapsedGroups(
  dimension: string,
  { defaultCollapsed = false }: { defaultCollapsed?: boolean } = {},
): CollapseState {
  const initial = () => ({ collapsedByDefault: defaultCollapsed, toggled: new Set<string>() as ReadonlySet<string> });
  const [state, setState] = useState(initial);
  const [lastDimension, setLastDimension] = useState(dimension);

  // Adjusted during render rather than in an effect: an effect would paint one
  // frame with the previous dimension's collapse state applied to the new
  // groups, which reads as groups randomly collapsing on their own. React
  // re-runs this component immediately on the set, before touching the DOM.
  if (lastDimension !== dimension) {
    setLastDimension(dimension);
    setState(initial);
  }

  const toggle = useCallback((key: string) => {
    setState((current) => {
      const toggled = new Set(current.toggled);
      if (!toggled.delete(key)) toggled.add(key);
      return { ...current, toggled };
    });
  }, []);

  const expandAll = useCallback(
    () => setState({ collapsedByDefault: false, toggled: new Set<string>() }),
    [],
  );
  const collapseAll = useCallback(
    () => setState({ collapsedByDefault: true, toggled: new Set<string>() }),
    [],
  );

  return useMemo(
    () => ({
      isCollapsed: (key: string) => state.toggled.has(key) !== state.collapsedByDefault,
      toggle,
      expandAll,
      collapseAll,
      allExpanded: !state.collapsedByDefault && state.toggled.size === 0,
      allCollapsed: state.collapsedByDefault && state.toggled.size === 0,
    }),
    [state, toggle, expandAll, collapseAll],
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

/**
 * Opens or shuts every group at once, beside the grouping control.
 *
 * One button rather than an expand/collapse pair, and in the header rather
 * than inside the grouping menu, where this used to live: a pair always has
 * one half greyed out, and a table that opens collapsed makes "expand
 * everything" the first thing many people want -- not something to go hunting
 * for a click deep in a dropdown. Half-open counts as open, so the button
 * offers to shut things until everything is already shut; either way one more
 * click gets back to where you were.
 */
export function GroupToggle({ collapse }: { collapse: CollapseState }) {
  const expand = collapse.allCollapsed;
  return (
    <button
      type="button"
      onClick={expand ? collapse.expandAll : collapse.collapseAll}
      title={expand ? "Open every group" : "Shut every group"}
      className="whitespace-nowrap rounded border border-transparent px-1.5 py-0.5 text-[10.5px] font-medium normal-case tracking-normal text-dim-2 transition-colors hover:border-border hover:text-foreground"
    >
      {expand ? "Expand all" : "Collapse all"}
    </button>
  );
}

export interface GroupingOption<K extends string> {
  value: K;
  /** How it reads in the menu: "By account". The "By " is part of the label so
   *  the "no grouping" entry can opt out of it. */
  label: string;
  /** The column this dimension corresponds to, where one exists. Used to mark
   *  that column's header while it's the active grouping. */
  column?: string;
}

/**
 * The grouping control, anchored in the table's leading column header.
 *
 * It used to be a select in the toolbar, on all three tables, with a separate
 * expand-all/collapse-all pair beside it -- six controls above the tables for
 * something that only acts on the table. Both live here now, in the header row
 * of the thing they reshape.
 *
 * Not one menu per groupable column, which is where this started: three of
 * Holdings' four dimensions (class, theme, side) aren't columns at all, so a
 * strictly per-column affordance could only ever offer a quarter of them.
 * Instead every dimension is listed in one place, and the column matching the
 * active one is marked -- see `groupedColumnMarker`.
 */
export function GroupMenu<K extends string>({
  options,
  value,
  onChange,
  collapse,
}: {
  options: readonly GroupingOption<K>[];
  value: K;
  onChange: (next: K) => void;
  /** Omitted when nothing is grouped, which is when there is nothing to fold. */
  collapse?: CollapseState;
}) {
  const [open, setOpen] = useState(false);
  // Where to paint the menu, in viewport coordinates. The tables scroll inside
  // a `max-h` container, so an absolutely-positioned menu is clipped by it --
  // the last option and the expand/collapse row simply weren't reachable.
  // Portalled to the body and placed against the button's own rect instead.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = wrap.current?.getBoundingClientRect();
      if (rect) setAt({ top: rect.bottom + 4, left: rect.left });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrap.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // A menu anchored to a header inside a scrolling table has to follow it,
    // and `true` catches the table's own scroll as well as the window's.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  const grouped = value !== "none";

  return (
    // The wrapper is what the portalled menu measures against, so the toggle
    // sitting inside it has to not move the button -- hence `items-center` on
    // an inline flex rather than the two of them wrapping independently.
    <span ref={wrap} className="relative inline-flex items-center gap-1 normal-case">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={grouped ? `Grouped ${current?.label.toLowerCase()}` : "Group this table"}
        className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[10.5px] font-medium tracking-normal transition-colors ${
          grouped
            ? "border-accent text-accent"
            : "border-transparent text-dim-2 hover:border-border hover:text-foreground"
        }`}
      >
        {grouped ? current?.label : "Group"} ▾
      </button>
      {open &&
        at &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            style={{ top: at.top, left: at.left }}
            className="fixed z-50 w-48 overflow-hidden rounded-md border border-border bg-panel text-left shadow-lg"
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] normal-case tracking-normal transition-colors hover:bg-panel-2 ${
                  option.value === value ? "text-accent" : "text-foreground"
                }`}
              >
                <span aria-hidden className="w-2.5 text-[10px]">
                  {option.value === value ? "●" : ""}
                </span>
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
      {collapse && grouped && <GroupToggle collapse={collapse} />}
    </span>
  );
}

/** Marks a column header as the one the table is currently grouped by. */
export function groupedColumnMarker(activeColumn: string | undefined, column: string): string {
  return activeColumn === column ? " ⌄" : "";
}
