import { create } from "zustand";

/** Whether the Assumptions drawer is open -- shared so both the header
 * button and other UI (e.g. the stale-plan banner's "Update now" link) can
 * open the same drawer instance. Not persisted, same as useWizardStore. */
interface AssumptionsUiState {
  open: boolean;
  openAssumptions: () => void;
  closeAssumptions: () => void;
}

export const useAssumptionsStore = create<AssumptionsUiState>((set) => ({
  open: false,
  openAssumptions: () => set({ open: true }),
  closeAssumptions: () => set({ open: false }),
}));
