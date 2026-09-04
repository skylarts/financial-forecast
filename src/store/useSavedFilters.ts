import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * A facet as it goes to disk. `FacetState.selected` is a Set, which JSON
 * turns into `{}` -- so the stored shape carries an array and the component
 * converts at the edges.
 */
export interface SavedFacet {
  mode: "include" | "exclude";
  selected: string[];
}

/**
 * One named filter combination: the search box plus every filter section,
 * keyed by the section's own key.
 *
 * Keyed generically rather than by named fields so this store never has to
 * learn which facets exist -- adding a section to the filter panel saves and
 * restores with it, and a combo saved before a section existed simply has no
 * entry for it, which restores as "no filter" and is the right answer.
 */
export interface SavedFilter {
  id: string;
  name: string;
  search: string;
  facets: Record<string, SavedFacet>;
}

interface SavedFiltersState {
  saved: SavedFilter[];
  addSavedFilter: (filter: Omit<SavedFilter, "id">) => void;
  removeSavedFilter: (id: string) => void;
}

/**
 * Saved filter combos, persisted locally alongside the other UI-only
 * preferences.
 *
 * Kept out of the portfolio document on purpose: these are one person's
 * shortcuts into their own data, not part of the ledger, so they have no
 * business riding along in an export or a cloud sync of the portfolio.
 */
export const useSavedFilters = create<SavedFiltersState>()(
  persist(
    (set) => ({
      saved: [],
      addSavedFilter: (filter) =>
        set((s) => ({
          // Saving under a name that already exists replaces it, which is what
          // "save" means once you have tweaked a combo you already keep.
          saved: [
            ...s.saved.filter((f) => f.name !== filter.name),
            { ...filter, id: crypto.randomUUID() },
          ],
        })),
      removeSavedFilter: (id) => set((s) => ({ saved: s.saved.filter((f) => f.id !== id) })),
    }),
    { name: "portfolio-saved-filters" },
  ),
);
