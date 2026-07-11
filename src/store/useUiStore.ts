import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "pink";

interface UiState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

/** UI-only preferences (not part of a financial plan), persisted separately. */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "pink" : "dark" })),
      setTheme: (theme) => set({ theme }),
    }),
    { name: "forecast-ui" }
  )
);
