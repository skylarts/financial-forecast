"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AccountGroup } from "@/lib/portfolio/accountTree";
import { Chevron } from "./Chevron";
import { FROZEN_CELL_GROUP, FrozenGroupLabel } from "./frozenColumn";

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
  /** The rows this group draws. A parent in a nested grouping draws none of
   *  its own -- its children draw them all -- so this is empty there. */
  rows: T[];
  /** What the group's subtotals cover. Identical to `rows` for a flat group;
   *  for a nested parent it is the whole family, which is the number a reader
   *  expects beside an account's name whether or not it is split in two. */
  totalRows: T[];
  /** 0 for a top-level group, 1 for a subdivision inside one. */
  depth: number;
  /** The group this one sits inside, so a table can hide it when that one is
   *  collapsed without having to walk the list. */
  parentKey: string | null;
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

  return [...map.entries()].map(([label, groupRows]) => ({
    key: label,
    label,
    rows: groupRows,
    totalRows: groupRows,
    depth: 0,
    parentKey: null,
  }));
}

/** How a row is filed when groups nest: a parent, and a subdivision within it. */
export interface NestedLabel {
  key: string;
  label: string;
  /** null when the group has no subdivisions -- the rows hang off it directly. */
  subKey: string | null;
  subLabel: string | null;
}

/**
 * Buckets rows two levels deep, flattened into the order they render: each
 * parent immediately followed by its own subdivisions.
 *
 * Flattened rather than nested because a table body is a flat list of `tr`s
 * either way, and a flat list is what lets subdivisions keep the paging,
 * collapse and subtotal machinery every group already has. A parent with only
 * one subdivision keeps its rows itself: "Brokerage" then "Brokerage" again
 * one indent in says nothing worth a row.
 */
export function buildNestedGroups<T>(
  rows: readonly T[],
  labelFor: (row: T) => NestedLabel,
): Group<T>[] {
  interface Bucket {
    label: string;
    rows: T[];
    subs: Map<string, { label: string; rows: T[] }>;
  }
  const parents = new Map<string, Bucket>();

  for (const row of rows) {
    const at = labelFor(row);
    let parent = parents.get(at.key);
    if (!parent) {
      parent = { label: at.label, rows: [], subs: new Map() };
      parents.set(at.key, parent);
    }
    parent.rows.push(row);
    if (at.subKey === null) continue;
    const sub = parent.subs.get(at.subKey);
    if (sub) sub.rows.push(row);
    else parent.subs.set(at.subKey, { label: at.subLabel ?? at.label, rows: [row] });
  }

  const out: Group<T>[] = [];
  for (const [key, parent] of parents) {
    const split = parent.subs.size > 1;
    out.push({
      key,
      label: parent.label,
      rows: split ? [] : parent.rows,
      totalRows: parent.rows,
      depth: 0,
      parentKey: null,
    });
    if (!split) continue;
    for (const [subKey, sub] of parent.subs) {
      out.push({
        key: subKey,
        label: sub.label,
        rows: sub.rows,
        totalRows: sub.rows,
        depth: 1,
        parentKey: key,
      });
    }
  }
  return out;
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
  // Only the top level is reordered, each parent carrying its own
  // subdivisions: ranking a flat list would scatter sleeves away from the
  // account they belong to, which is the one thing the nesting exists to stop.
  const children = new Map<string, Group<T>[]>();
  for (const group of groups) {
    if (group.parentKey === null) continue;
    const bucket = children.get(group.parentKey);
    if (bucket) bucket.push(group);
    else children.set(group.parentKey, [group]);
  }

  return groups
    .filter((group) => group.parentKey === null)
    .map((group) => ({ group, rank: total(group.totalRows) }))
    .sort((a, b) => (a.rank - b.rank) * factor)
    .flatMap((entry) => [entry.group, ...(children.get(entry.group.key) ?? [])]);
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

/** Every cell on a group's row: its label, its subtotals, the gaps between. */
const CELL = "border-b border-border px-3 py-1.5 text-[11.5px]";

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
  leadSpan = 0,
  depth = 0,
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
  /** How many of those come before the frozen column. Transactions' checkbox
   *  is the only one: it scrolls under the frozen column rather than being
   *  part of it, on a group's row as on any other. */
  leadSpan?: number;
  /** 0 for a group, 1 for a subdivision inside one -- indented, so a sleeve
   *  reads as part of the account above it rather than as another account. */
  depth?: number;
  /** One node per trailing column, right-aligned. `null` renders an empty cell. */
  cells: readonly React.ReactNode[];
}) {
  // The label sits in the frozen column itself rather than in one cell
  // spanning up to it. Spanning was what let the label scroll away: a sticky
  // child only sticks as far as its own cell reaches, so on a wide table the
  // group name eventually slid off and the figures behind it slid over the
  // top. Being the frozen column, it now stays put and they pass underneath.
  const trailingSpan = labelSpan - leadSpan - 1;
  return (
    // The border is on the cells, not the row: these tables are
    // `border-separate` so their label column can be frozen, and a separated
    // table draws no `tr` borders at all.
    <tr className={depth > 0 ? "bg-panel" : "bg-panel-2"}>
      {leadSpan > 0 && <td colSpan={leadSpan} className={`${CELL} text-left`} />}
      <td className={`${CELL} ${FROZEN_CELL_GROUP} text-left`}>
        <FrozenGroupLabel>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            title={collapsed ? `Show ${label}` : `Hide ${label}`}
            style={depth > 0 ? { paddingLeft: depth * 14 } : undefined}
            className={`flex max-w-full items-center gap-1.5 whitespace-nowrap text-[11.5px] transition-colors hover:text-foreground ${
              depth > 0 ? "font-medium text-dim-2" : "font-semibold text-dim"
            }`}
          >
            <Chevron open={!collapsed} />
            {/* Held to the frozen column's width on a phone, these two are
                competing for a column only as wide as a date, and the name is
                what identifies the group -- "S.. 8 rows" says nothing. So the
                count gives up its noun first, leaving the bare number, and
                only then does the name ellipsise. The number keeps `shrink-0`
                either way: a half-drawn count reads as a wrong number. */}
            <span className="truncate">{label}</span>
            <span className="shrink-0 font-normal text-dim-2">
              {count}
              <span className="hidden sm:inline"> {count === 1 ? noun : `${noun}s`}</span>
            </span>
          </button>
        </FrozenGroupLabel>
      </td>
      {trailingSpan > 0 && <td colSpan={trailingSpan} className={CELL} />}
      {cells.map((cell, i) => (
        <td
          // Positional by nature: these are columns, not entities, and they
          // never reorder within a table.
          key={i}
          className={`${CELL} text-right font-semibold tabular-nums`}
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
  const label = expand ? "Expand all" : "Collapse all";
  return (
    <button
      type="button"
      onClick={expand ? collapse.expandAll : collapse.collapseAll}
      title={expand ? "Open every group" : "Shut every group"}
      aria-label={label}
      className="flex shrink-0 items-center whitespace-nowrap rounded border border-transparent px-1.5 py-0.5 text-[10.5px] font-medium normal-case tracking-normal text-dim-2 transition-colors hover:border-border hover:text-foreground"
    >
      {/* Wordless on a phone. This sits in a table header only as wide as its
          own contents, and the words made it a third stacked line of chrome
          above the first row of data. */}
      <ExpandIcon open={expand} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/**
 * A double chevron, down to open every group and up to shut them.
 *
 * Not the two chevrons drawn apart and together that this sort of control
 * often uses: at the twelve pixels there is room for here, chevrons pointing
 * at each other make an x, and an x in a corner of a table reads as "close
 * this", which is the one thing the button does not do.
 */
function ExpandIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className="h-3 w-3 sm:hidden"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <path d="M3 3 6 6 9 3" />
          <path d="M3 7 6 10 9 7" />
        </>
      ) : (
        <>
          <path d="M3 6 6 3 9 6" />
          <path d="M3 10 6 7 9 10" />
        </>
      )}
    </svg>
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
    // an inline flex rather than the two of them wrapping independently. And
    // no wrapping within it either: the two controls are then one item as far
    // as the header column's width is concerned, and share a line instead of
    // stacking into two.
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
        {grouped ? (
          <>
            {/* "By account" reads better in a sentence, but the column this
                sits in is barely wider than the words; the "By" is the half
                that carries no information. */}
            <span className="hidden sm:inline">{current?.label}</span>
            <span className="sm:hidden">{withoutBy(current?.label ?? "")}</span>
          </>
        ) : (
          "Group"
        )}{" "}
        ▾
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

/** "By account" -> "Account". Anything not phrased that way is left alone. */
function withoutBy(label: string): string {
  const rest = label.replace(/^By /, "");
  return rest === label ? label : rest[0].toUpperCase() + rest.slice(1);
}

/**
 * Marks a column header as the one the table is currently grouped by.
 *
 * Joined by a non-breaking space: a header narrow enough to wrap put the mark
 * on a line of its own underneath, which on a phone cost the whole header row
 * a second line for one glyph.
 */
export function groupedColumnMarker(activeColumn: string | undefined, column: string): string {
  return activeColumn === column ? "\u00a0⌄" : "";
}

/**
 * How one row files under an account, for `buildNestedGroups`.
 *
 * Falls back to the flat account name when the account is unknown to the
 * grouping map -- a row whose account has been deleted still has to land
 * somewhere visible.
 */
export function nestedAccountLabel(
  accountId: string,
  accountNames: Map<string, string>,
  accountGroups?: Map<string, AccountGroup>,
): NestedLabel {
  const group = accountGroups?.get(accountId);
  if (group) {
    return { key: group.key, label: group.label, subKey: group.subKey, subLabel: group.subLabel };
  }
  const label = accountNames.get(accountId) ?? "Unknown account";
  return { key: accountId, label, subKey: null, subLabel: null };
}
