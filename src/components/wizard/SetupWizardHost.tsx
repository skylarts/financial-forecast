"use client";

import { useEffect, useRef } from "react";
import { usePlanStore, planHasContent } from "@/store/usePlanStore";
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
    if (planHasContent(usePlanStore.getState().plan)) {
      // A plan already exists (an earlier build, another device, a restored
      // file): never surprise a returning user with the guide.
      markOnboardingCompleted();
      return;
    }
    // The empty first-run state offers the guide as a button; auto-opening
    // it on top would show two invitations at once.
  }, [hasHydrated, authLoading, cloudSyncReady, openWizard]);

  const handleClose = () => {
    markOnboardingCompleted();
    closeWizard();
  };

  return <SetupWizard open={open} onClose={handleClose} />;
}
