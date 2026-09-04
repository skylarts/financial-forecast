"use client";

import type { ReactNode } from "react";

/**
 * Freezing the label column on the wide portfolio tables.
 *
 * Holdings, Performance by stock, Realized and Transactions are all wider
 * than a phone and wider than a narrow window, so their numbers get read by
 * scrolling sideways -- and the symbol scrolled away with everything else,
 * leaving a row of figures belonging to nothing. The identifying column is
 * pinned instead, the way a spreadsheet freezes its first column. The
 * forecast tables have always done this; these four couldn't.
 *
 * What stopped them was `border-collapse`. A collapsed border belongs to the
 * table's grid rather than to the cell, so a sticky cell travels out from
 * under its own borders, and `position: sticky` on a `tr` only works at all
 * while the table is collapsed. So these tables are `border-separate` now,
 * and everything else here follows from that: row borders have to be drawn
 * per cell, and the sticky header and totals rows move off their `tr` and
 * onto the cells themselves.
 *
 * No constant here carries a `z-index`. Two of them land on one cell -- the
 * frozen column's header is also a sticky header cell -- and two `z-*`
 * classes on one element resolve by stylesheet order rather than by the
 * order they were written, which is not a thing to leave to luck.
 */
export const TABLE = "w-full border-separate border-spacing-0";

const FROZEN_BASE =
  // `border-r-border` spelled out because the row border these cells also
  // carry is the softer of the two weights, and a bare `border-border`
  // alongside it is two colour utilities racing on stylesheet order.
  "sticky left-0 z-[2] border-r border-r-border group-hover:bg-panel-2";

/**
 * The frozen column's body cell.
 *
 * Opaque, because the rest of the row passes underneath it -- which also
 * means it can't pick up the row's hover tint the way a transparent cell
 * does, hence `group-hover` here and `group` on the row.
 */
export const FROZEN_CELL = `${FROZEN_BASE} bg-panel`;

/**
 * The same cell on a row that carries a tint of its own -- a selected
 * transaction, say. The row's translucent tint can't just be left to show
 * through, because what is behind this cell is the rest of the table sliding
 * under it, so the tint is mixed into an opaque colour here instead. One
 * background utility or the other, never both: two of them on one element
 * resolve by stylesheet order, and the plain one wins.
 */
export const FROZEN_CELL_TINTED = `${FROZEN_BASE} bg-[color-mix(in_srgb,var(--accent)_10%,var(--panel))]`;

/**
 * How wide the frozen column is allowed to get on a narrow screen.
 *
 * Uncapped it takes its width from its longest security name and from the
 * grouping control in its header -- around 235px, which is two thirds of a
 * phone and leaves the numbers nowhere to go, so freezing the column would
 * cost more than it bought. Applied to the cell's contents rather than to the
 * cell: a `max-width` on a table cell is a suggestion the browser may ignore,
 * while a capped box inside it genuinely shrinks what the column asks for.
 * Above `sm` there is room and the cap lifts.
 */
export const FROZEN_WIDTH = "max-w-[10rem] sm:max-w-none";

/** Pins a header or totals cell sideways, above its sticky neighbours. */
export const FROZEN_STICKY = "sticky left-0 z-20 border-r border-border";

const FOOT_BASE =
  "sticky bottom-0 border-t border-border bg-panel-2 px-3 py-2 text-[12.5px] font-semibold tabular-nums";

/** A cell in the totals row pinned to the bottom of the scroll area. */
export const FOOT = `${FOOT_BASE} z-10`;

/** That row's cell in the frozen column, pinned both ways. */
export const FOOT_FROZEN = `${FOOT_BASE} ${FROZEN_STICKY}`;

/**
 * Keeps a label put in a cell that spans the frozen column instead of being
 * it -- a group header, a totals row. The cell itself can't be sticky without
 * sliding over the columns it spans, so its contents are, which parks the
 * label directly above the frozen column as the table scrolls.
 */
export function FrozenLabel({ children }: { children: ReactNode }) {
  return <div className="sticky left-0 w-fit">{children}</div>;
}
