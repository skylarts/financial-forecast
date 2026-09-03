import { ASSET_CLASS_LABELS, INSTRUMENT_TYPE_LABELS, type AssetClass, type Exposure, type InstrumentType, type PortfolioAccount } from "@/domain/portfolio";
import type { Person } from "@/domain/household";
import { EMPTY_FACET, facetActive, facetMatches, type FacetOption, type FacetState } from "@/components/ui/facets";
import { accountFamilyIds, accountTreeRows } from "@/lib/portfolio/accountTree";
import { ownerLabel } from "@/lib/people";

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

/* ---------------------------------------------------------------------------
   Accounts.

   Which accounts you're looking at used to be a `<select>` of its own sitting
   beside the filter button: one choice at a time, so "Skylar's Roth and the
   joint brokerage" was not a thing you could ask for, and the answer to "which
   accounts?" lived in a different control from every other answer.

   It's a facet now, with one difference that matters and is worth stating: the
   other three narrow the rows a view lists, while this one decides which
   accounts are valued at all. Everything downstream -- the summary tiles, the
   performance series, the ledger -- reads the resolved id list, so picking an
   account here reshapes the page rather than just filtering a table.
   --------------------------------------------------------------------------- */

/**
 * One option per account, in tree order (a split account's sleeves directly
 * under it), grouped by whose the account is.
 *
 * A sleeve is labelled with its parent's name attached, because "Roth" alone
 * is not an account anyone recognises out of context -- and this label is what
 * the chip outside the menu has to stand on.
 */
export function accountFacetOptions(
  accounts: readonly PortfolioAccount[],
  people: readonly Person[],
): FacetOption[] {
  const byOwner = new Map<string, FacetOption[]>();

  for (const { account, depth } of accountTreeRows(accounts)) {
    const parent = accounts.find((a) => a.id === account.parentAccountId);
    const group = ownerLabel(people, account.ownerId);
    const label = depth > 0 && parent ? `${parent.name} / ${account.name}` : account.name;
    const options = byOwner.get(group) ?? [];
    options.push({ value: account.id, label, group });
    byOwner.set(group, options);
  }

  // Owners in the order the household lists them, "Joint" last -- the same
  // order the old picker's optgroups used.
  return [...byOwner.entries()]
    .sort(([a], [b]) => (a === "Joint" ? 1 : b === "Joint" ? -1 : 0))
    .flatMap(([, options]) => options);
}

/**
 * The account ids this facet covers, or `null` for "every account" -- the
 * shape `analyzePortfolio`'s `accountIds` option wants.
 *
 * Choosing an account that has sleeves covers the sleeves too, in either mode:
 * picking a pre-tax/Roth-split 401(k) means the whole 401(k), and hiding it
 * hides all of it. Picking one sleeve covers only that sleeve.
 *
 * Hiding every account resolves to an empty list, not to "all". A filter that
 * quietly gave back what it was told to hide would be worse than one that
 * shows you an empty portfolio and the chips explaining why.
 */
export function accountIdsForFacet(
  accounts: readonly PortfolioAccount[],
  facet: FacetState,
): string[] | null {
  if (facet.selected.size === 0) return null;

  const named = new Set<string>();
  for (const id of facet.selected) {
    // An id naming nothing real (an account deleted while it was filtered on)
    // contributes nothing rather than widening the scope back out.
    if (accounts.some((a) => a.id === id)) {
      for (const familyId of accountFamilyIds(accounts, id)) named.add(familyId);
    }
  }

  if (facet.mode === "include") return [...named];
  return accounts.filter((a) => !named.has(a.id)).map((a) => a.id);
}
