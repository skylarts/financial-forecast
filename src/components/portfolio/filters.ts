import { ASSET_CLASS_LABELS, INSTRUMENT_TYPE_LABELS, type AssetClass, type Exposure, type InstrumentType } from "@/domain/portfolio";
import { EMPTY_FACET, facetActive, facetMatches, type FacetOption, type FacetState } from "@/components/ui/facets";

/** A holding with no theme tags falls into this bucket for grouping and
 *  filtering, the same convention the theme allocation view uses. */
export const UNTAGGED = "Untagged";

/**
 * The three fields every filterable row carries, whether it's a per-account
 * `Holding` or a symbol rolled up across accounts in `SymbolRollup` -- the
 * facets only ever read these, so they work unchanged on either.
 */
export interface Classifiable {
  exposures: readonly Exposure[];
  themes: readonly string[];
  instrumentType: InstrumentType;
}

/**
 * The one filter shape shared by Holdings, By stock, and Performance, so a
 * facet reads the same way and narrows the same rows on every tab it appears
 * on.
 */
export interface HoldingFacets {
  assetClass: FacetState;
  theme: FacetState;
  instrumentType: FacetState;
}

export function emptyHoldingFacets(): HoldingFacets {
  return { assetClass: EMPTY_FACET, theme: EMPTY_FACET, instrumentType: EMPTY_FACET };
}

export function holdingFacetsActive(facets: HoldingFacets): boolean {
  return facetActive(facets.assetClass) || facetActive(facets.theme) || facetActive(facets.instrumentType);
}

function assetClassesOf(row: Classifiable): string[] {
  return row.exposures.map((e) => e.assetClass);
}

function themesOf(row: Classifiable): string[] {
  return row.themes.length > 0 ? [...row.themes] : [UNTAGGED];
}

function instrumentTypeOf(row: Classifiable): string[] {
  return [row.instrumentType];
}

export function matchesHoldingFacets(row: Classifiable, facets: HoldingFacets): boolean {
  return (
    facetMatches(assetClassesOf(row), facets.assetClass) &&
    facetMatches(themesOf(row), facets.theme) &&
    facetMatches(instrumentTypeOf(row), facets.instrumentType)
  );
}

/**
 * Options and counts for one facet, counted against rows that already pass
 * every *other* facet -- so picking a theme first narrows what the asset-class
 * menu counts, but a facet's own selection never shrinks its own option list
 * out from under it.
 */
function optionsFor(
  rows: readonly Classifiable[],
  facets: HoldingFacets,
  key: keyof HoldingFacets,
  pick: (row: Classifiable) => string[],
  labelFor: (value: string) => string,
): FacetOption[] {
  const others: HoldingFacets = { ...facets, [key]: EMPTY_FACET };
  const matching = rows.filter((row) => matchesHoldingFacets(row, others));
  const counts = new Map<string, number>();
  for (const row of matching) {
    for (const value of pick(row)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: labelFor(value), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function assetClassFacetOptions(rows: readonly Classifiable[], facets: HoldingFacets): FacetOption[] {
  return optionsFor(rows, facets, "assetClass", assetClassesOf, (v) => ASSET_CLASS_LABELS[v as AssetClass] ?? v);
}

export function themeFacetOptions(rows: readonly Classifiable[], facets: HoldingFacets): FacetOption[] {
  return optionsFor(rows, facets, "theme", themesOf, (v) => v);
}

export function instrumentTypeFacetOptions(rows: readonly Classifiable[], facets: HoldingFacets): FacetOption[] {
  return optionsFor(
    rows,
    facets,
    "instrumentType",
    instrumentTypeOf,
    (v) => INSTRUMENT_TYPE_LABELS[v as InstrumentType] ?? v,
  );
}
