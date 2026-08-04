"use client";

import { useEffect, useRef, useState } from "react";
import { planSchema } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { useAuth } from "@/components/auth/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { getHouseholdId } from "@/lib/supabase/household";
import { migrateLegacyBuyHomeEvents } from "@/lib/migrateLegacyBuyHome";

const SYNC_DEBOUNCE_MS = 1500;

/** Resolves the signed-in user's household id (if their email is paired with
 * a spouse -- see supabase/household_linking.sql), so useCloudSync can key
 * the shared plan row off the household instead of the individual user.
 * `resolved` stays false until the lookup for the *current* user settles,
 * so callers don't briefly sync to a user-scoped row before household
 * membership is known. */
function useHouseholdId(userId: string | undefined, email: string | null | undefined) {
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const resolvingForUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    if (resolvingForUserId.current === userId) return;
    resolvingForUserId.current = userId;
    setResolved(false);
    void getHouseholdId(email).then((id) => {
      setHouseholdId(id);
      setResolved(true);
    });
  }, [userId, email]);

  return { householdId, resolved };
}

/** Mounted once near the root. While signed out, this is a no-op and the app
 * behaves exactly as it does today (local-only). While signed in, it pulls
 * the user's cloud plan on sign-in (cloud wins, matching the app's
 * last-write-wins model) and pushes local edits up on a short debounce,
 * keyed off `lastSavedAt` -- the same timestamp every plan mutation
 * (including a local JSON restore) already stamps.
 *
 * Returns `cloudSyncReady`: true immediately for a signed-out user (nothing
 * to pull), true once the pull attempt for the current user has settled
 * (success, empty, or error) for a signed-in one. Callers that need to know
 * whether *this* browser is truly first-run (e.g. the setup wizard's
 * auto-prompt) should wait for this before checking local state, otherwise
 * a returning user signed in on a new device could be prompted for a moment
 * before their cloud plan lands. */
export function useCloudSync(): { cloudSyncReady: boolean } {
  const { user } = useAuth();
  const hasHydrated = usePlanStore((s) => s.hasHydrated);
  const loadPlan = usePlanStore((s) => s.loadPlan);
  const { householdId, resolved: householdResolved } = useHouseholdId(user?.id, user?.email);
  const pulledForUserId = useRef<string | null>(null);
  const [pullCompleteForUserId, setPullCompleteForUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !hasHydrated || !householdResolved) return;
    if (pulledForUserId.current === user.id) return;
    pulledForUserId.current = user.id;

    const supabase = createClient();
    // A household member's plan lives in the row shared with their spouse,
    // keyed by household_id instead of user_id -- see
    // supabase/household_linking.sql. Unpaired users keep the original
    // per-user row.
    const filterColumn = householdId ? "household_id" : "user_id";
    const filterValue = householdId ?? user.id;

    (async () => {
      try {
        const { data, error } = await supabase
          .from("plans")
          .select("plan")
          .eq(filterColumn, filterValue)
          .maybeSingle();

        if (error) {
          console.warn("Failed to load cloud plan; keeping local plan.", error);
          return;
        }

        if (data?.plan) {
          // A cloud row can predate the buy-home unification (saved from an
          // older build, or written by a device that hasn't upgraded yet) --
          // migrate it the same way importPlan/localStorage rehydration do,
          // so a legacy-shaped plan doesn't fail validation, and so it can't
          // drift out of sync with a locally-migrated copy of the same plan.
          const migrated = migrateLegacyBuyHomeEvents(data.plan);
          const result = planSchema.safeParse(migrated);
          if (result.success) {
            loadPlan(result.data);
            return;
          }
          console.warn("Cloud plan failed validation; keeping local plan.", result.error);
          return;
        }

        // No cloud row yet -- push the current local plan up as the first copy.
        const localPlan = usePlanStore.getState().plan;
        await supabase.from("plans").upsert(
          {
            user_id: user.id,
            ...(householdId ? { household_id: householdId } : {}),
            plan: localPlan,
            updated_at: new Date().toISOString(),
          },
          householdId ? { onConflict: "household_id" } : undefined
        );
      } finally {
        setPullCompleteForUserId(user.id);
      }
    })();
  }, [user, hasHydrated, householdId, householdResolved, loadPlan]);

  useEffect(() => {
    if (!user || !hasHydrated || !householdResolved) return;

    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeen = usePlanStore.getState().lastSavedAt;

    const unsubscribe = usePlanStore.subscribe((state) => {
      if (state.lastSavedAt === lastSeen) return;
      lastSeen = state.lastSavedAt;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const plan = usePlanStore.getState().plan;
        void supabase
          .from("plans")
          .upsert(
            {
              user_id: user.id,
              ...(householdId ? { household_id: householdId } : {}),
              plan,
              updated_at: new Date().toISOString(),
            },
            householdId ? { onConflict: "household_id" } : undefined
          )
          .then(({ error }) => {
            if (error) console.warn("Failed to sync plan to the cloud.", error);
          });
      }, SYNC_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [user, hasHydrated, householdId, householdResolved]);

  return { cloudSyncReady: !user || pullCompleteForUserId === user.id };
}
