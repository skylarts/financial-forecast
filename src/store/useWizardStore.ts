import { create } from "zustand";

/** Whether the guided setup wizard modal is open -- deliberately NOT
 * persisted (unlike usePlanStore/useUiStore): the wizard's own open/closed
 * state shouldn't survive a reload, whether it was triggered by the header
 * button or the first-run auto-prompt. */
interface WizardState {
  open: boolean;
  openWizard: () => void;
  closeWizard: () => void;
}

export const useWizardStore = create<WizardState>((set) => ({
  open: false,
  openWizard: () => set({ open: true }),
  closeWizard: () => set({ open: false }),
}));
