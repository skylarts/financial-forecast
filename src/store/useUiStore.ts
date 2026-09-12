import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_STRESS_PARAMS, type StressKey, type StressParams } from "@/engine/stress";

export type Theme = "dark" | "joy";

function toggleInArray(arr: string[], key: string): string[] {
  return arr.includes(key) ? arr.filter((k) => k !== key) : [...arr, key];
}

interface UiState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  /** Cash Flow tab's "Taxes (informational)" section -- collapsed by default,
   *  remembered across reloads/sign-ins the same way as everything else here. */
  cashFlowTaxesOpen: boolean;
  setCashFlowTaxesOpen: (open: boolean) => void;
  /** All other expand/collapse toggles on the Cash Flow and Accounts pages --
   *  everything starts collapsed, but once a user opens a section it stays
   *  open on future visits instead of resetting. Keyed by whatever id each
   *  page uses for its section/group/row (namespaced where needed to avoid
   *  collisions between pages). */
  cashFlowExpanded: string[];
  toggleCashFlowExpanded: (key: string) => void;
  accountsExpanded: string[];
  toggleAccountsExpanded: (key: string) => void;
  /** Bumped by the empty first-run state to open the Data menu's file picker; not persisted. */
  restoreRequest: number;
  requestRestore: () => void;
  /** The stress preset drawn as a second line on the Overview chart, if any. */
  stressOverlay: StressKey | null;
  setStressOverlay: (key: StressKey | null) => void;
  /** How hard each stress preset hits; shared by the chart overlay and the Stress test tab. */
  stressParams: StressParams;
  setStressParams: (params: StressParams) => void;
}

/** UI-only preferences (not part of a financial plan), persisted separately. */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "joy" : "dark" })),
      setTheme: (theme) => set({ theme }),
      cashFlowTaxesOpen: false,
      setCashFlowTaxesOpen: (open) => set({ cashFlowTaxesOpen: open }),
      cashFlowExpanded: [],
      toggleCashFlowExpanded: (key) => set((s) => ({ cashFlowExpanded: toggleInArray(s.cashFlowExpanded, key) })),
      accountsExpanded: [],
      toggleAccountsExpanded: (key) => set((s) => ({ accountsExpanded: toggleInArray(s.accountsExpanded, key) })),
      restoreRequest: 0,
      requestRestore: () => set((s) => ({ restoreRequest: s.restoreRequest + 1 })),
      stressOverlay: null,
      setStressOverlay: (key) => set({ stressOverlay: key }),
      stressParams: DEFAULT_STRESS_PARAMS,
      setStressParams: (params) => set({ stressParams: params }),
    }),
    {
      name: "forecast-ui",
      partialize: (s) => ({
        theme: s.theme,
        cashFlowTaxesOpen: s.cashFlowTaxesOpen,
        cashFlowExpanded: s.cashFlowExpanded,
        accountsExpanded: s.accountsExpanded,
        stressOverlay: s.stressOverlay,
        stressParams: s.stressParams,
      }),
      // A stress preset saved by an older build may lack a newer parameter.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        return { ...current, ...p, stressParams: { ...DEFAULT_STRESS_PARAMS, ...(p.stressParams ?? {}) } };
      },
    }
  )
);
