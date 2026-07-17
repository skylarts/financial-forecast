"use client";

import { useEffect, useRef } from "react";
import { usePlanStore, hadExistingPlanOnLoad } from "@/store/usePlanStore";
import { useAuth } from "@/components/auth/AuthProvider";
import { useWizardStore } from "@/store/useWizardStore";
import { hasCompletedOnboarding, markOnboardingCompleted } from "@/lib/onboarding";
import { SetupWizard } from "./SetupWizard";

/**
 * Decides, once per page load, whether the guided setup wizard should
 * auto-open for a genuinely first-time user -- then renders the wizard
 * itself, shared with the header's manual "Setup Guide" button via
 * useWizardStore so there's only ever one modal instance.
 *
 * Waits for hasHydrated (local storage read), auth to resolve, and (for a
 * signed-in user) the cloud plan pull to settle before deciding -- otherwise
 * a returning user signed in on a new device could flash the wizard for a
 * moment before their existing cloud plan loads in.
 */
export function SetupWizardHost({ cloudSyncReady }: { cloudSyncReady: boolean }) {
  const hasHydrated = usePlanStore((s) => s.hasHydrated);
  const { loading: authLoading } = useAuth();
  const open = useWizardStore((s) => s.open);
  const openWizard = useWizardStore((s) => s.openWizard);
  const closeWizard = useWizardStore((s) => s.closeWizard);
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || !hasHydrated || authLoading || !cloudSyncReady) return;
    decided.current = true;

    if (hasCompletedOnboarding()) return;
    if (hadExistingPlanOnLoad()) {
      // Existing user from before this feature shipped -- grandfather them
      // in silently rather than surprising a returning user with a wizard.
      markOnboardingCompleted();
      return;
    }
    openWizard();
  }, [hasHydrated, authLoading, cloudSyncReady, openWizard]);

  const handleClose = () => {
    markOnboardingCompleted();
    closeWizard();
  };

  return <SetupWizard open={open} onClose={handleClose} />;
}
