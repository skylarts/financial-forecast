/**
 * The app's top-level views, shown as tabs in the header.
 *
 * "Overview" is the projection dashboard (KPIs + chart); the rest are the
 * detail views that used to live in a second row of tabs below the chart.
 * Flattening them into one tab set means only one thing is on screen at a
 * time, so each view gets the full window height.
 */
export const VIEWS = ["Overview", "Cash Flow", "Accounts", "Timeline", "Routing"] as const;

export type View = (typeof VIEWS)[number];

/** Views that render a detail panel rather than the overview dashboard. */
export type DetailView = Exclude<View, "Overview">;
