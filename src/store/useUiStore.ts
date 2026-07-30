import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "joy";

interface UiState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  /** Cash Flow tab's "Taxes (informational)" section -- collapsed by default,
   *  remembered across reloads/sign-ins the same way as everything else here. */
  cashFlowTaxesOpen: boolean;
  setCashFlowTaxesOpen: (open: boolean) => void;
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
    }),
    { name: "forecast-ui" }
  )
);
