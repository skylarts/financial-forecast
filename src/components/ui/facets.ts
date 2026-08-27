export interface FacetOption {
  value: string;
  label: string;
  /** How many rows this option currently matches, so picking between two
   *  near-empty options doesn't mean guessing which one does anything. */
  count: number;
}

export interface FacetState {
  mode: "include" | "exclude";
  /** Empty means "nothing chosen", which reads as no filter at all --
   *  distinct from choosing every option, which (in include mode) filters
   *  down to exactly what's chosen even if that happens to be everything
   *  currently present. */
  selected: ReadonlySet<string>;
}

export const EMPTY_FACET: FacetState = { mode: "include", selected: new Set() };

export function facetActive(facet: FacetState): boolean {
  return facet.selected.size > 0;
}

/** Whether `values` (a row's one or several tags for this facet) survive it. */
export function facetMatches(values: readonly string[], facet: FacetState): boolean {
  if (facet.selected.size === 0) return true;
  const hits = values.some((v) => facet.selected.has(v));
  return facet.mode === "include" ? hits : !hits;
}
