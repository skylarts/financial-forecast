"use client";

import { useEffect, useRef } from "react";
import { planSchema } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { useAuth } from "@/components/auth/AuthProvider";
import { createClient } from "@/lib/supabase/client";

const SYNC_DEBOUNCE_MS = 1500;

/** Mounted once near the root. While signed out, this is a no-op and the app
 * behaves exactly as it does today (local-only). While signed in, it pulls
 * the user's cloud plan on sign-in (cloud wins, matching the app's
 * last-write-wins model) and pushes local edits up on a short debounce,
 * keyed off `lastSavedAt` -- the same timestamp every plan mutation
 * (including a local JSON restore) already stamps. */
export function useCloudSync() {
  const { user } = useAuth();
  const hasHydrated = usePlanStore((s) => s.hasHydrated);
  const loadPlan = usePlanStore((s) => s.loadPlan);
  const pulledForUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!user || !hasHydrated) return;
    if (pulledForUserId.current === user.id) return;
    pulledForUserId.current = user.id;

    const supabase = createClient();

    (async () => {
      const { data, error } = await supabase
        .from("plans")
        .select("plan")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) {
        console.warn("Failed to load cloud plan; keeping local plan.", error);
        return;
      }

      if (data?.plan) {
        const result = planSchema.safeParse(data.plan);
        if (result.success) {
          loadPlan(result.data);
          return;
        }
        console.warn("Cloud plan failed validation; keeping local plan.", result.error);
        return;
      }

      // No cloud row yet -- push the current local plan up as the first copy.
      const localPlan = usePlanStore.getState().plan;
      await supabase.from("plans").upsert({ user_id: user.id, plan: localPlan, updated_at: new Date().toISOString() });
    })();
  }, [user, hasHydrated, loadPlan]);

  useEffect(() => {
    if (!user || !hasHydrated) return;

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
          .upsert({ user_id: user.id, plan, updated_at: new Date().toISOString() })
          .then(({ error }) => {
            if (error) console.warn("Failed to sync plan to the cloud.", error);
          });
      }, SYNC_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [user, hasHydrated]);
}
