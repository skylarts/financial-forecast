const SEEN_KEY = "forecast-onboarding-completed";

/** Whether this browser has ever closed/finished the guided setup wizard --
 * independent of whether a plan exists, so dismissing on the welcome screen
 * still counts and the wizard never auto-prompts again on this browser. */
export function hasCompletedOnboarding(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(SEEN_KEY) !== null;
}

export function markOnboardingCompleted(): void {
  if (typeof window !== "undefined") window.localStorage.setItem(SEEN_KEY, "1");
}
