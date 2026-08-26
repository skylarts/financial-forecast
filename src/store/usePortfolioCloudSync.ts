"use client";

import { useEffect, useRef, useState } from "react";
import { portfolioSchema } from "@/domain/portfolio";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { useAuth } from "@/components/auth/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { getHouseholdId } from "@/lib/supabase/household";

const SYNC_DEBOUNCE_MS = 1500;

/** See useCloudSync's identical helper -- resolves the signed-in user's
 * household id (if their email is paired with a spouse) so this hook can key
 * the shared portfolio row off the household instead of the individual
 * user, same as the forecast plan does. */
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

/** Mounted once near the root of the portfolio tool. Same shape as
 * useCloudSync for the forecast plan: a no-op while signed out (the tracker
 * behaves exactly as it does today, local-only), and while signed in it
 * pulls the cloud portfolio on sign-in (cloud wins) and pushes local edits
 * up on a short debounce, keyed off `lastSavedAt`.
 *
 * The push side doesn't go live until this user's pull has settled -- see
 * the comment at the second effect below for why that matters more here
 * than it looks: this store also gets written by a chatty auto-mutation
 * (every quote refresh restamps a security's last-known price), so a naive
 * "start listening immediately" gate had a real window to clobber a shared
 * cloud row with a fresh device's empty local state. */
export function usePortfolioCloudSync(): { cloudSyncReady: boolean } {
  const { user } = useAuth();
  const hasHydrated = usePortfolioStore((s) => s.hasHydrated);
  const loadPortfolio = usePortfolioStore((s) => s.loadPortfolio);
  const { householdId, resolved: householdResolved } = useHouseholdId(user?.id, user?.email);
  const pulledForUserId = useRef<string | null>(null);
  const [pullCompleteForUserId, setPullCompleteForUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !hasHydrated || !householdResolved) return;
    if (pulledForUserId.current === user.id) return;
    pulledForUserId.current = user.id;

    const supabase = createClient();
    const filterColumn = householdId ? "household_id" : "user_id";
    const filterValue = householdId ?? user.id;

    (async () => {
      try {
        const { data, error } = await supabase
          .from("portfolios")
          .select("portfolio")
          .eq(filterColumn, filterValue)
          .maybeSingle();

        if (error) {
          console.warn("Failed to load cloud portfolio; keeping local portfolio.", error);
          return;
        }

        if (data?.portfolio) {
          const result = portfolioSchema.safeParse(data.portfolio);
          if (result.success) {
            loadPortfolio(result.data);
            return;
          }
          console.warn("Cloud portfolio failed validation; keeping local portfolio.", result.error);
          return;
        }

        // No cloud row yet -- push the current local portfolio up as the
        // first copy, so this device's local data becomes the seed instead
        // of being silently shadowed by an empty cloud row.
        const localPortfolio = usePortfolioStore.getState().portfolio;
        await supabase.from("portfolios").upsert(
          {
            user_id: user.id,
            ...(householdId ? { household_id: householdId } : {}),
            portfolio: localPortfolio,
            updated_at: new Date().toISOString(),
          },
          householdId ? { onConflict: "household_id" } : undefined
        );
      } finally {
        setPullCompleteForUserId(user.id);
      }
    })();
  }, [user, hasHydrated, householdId, householdResolved, loadPortfolio]);

  useEffect(() => {
    if (!user || !hasHydrated || !householdResolved) return;
    // Wait for this user's pull to settle before subscribing. Two problems
    // solved by the same gate: subscribing early lets the price-writeback
    // effect stamp lastSavedAt on a fresh device's still-empty local
    // portfolio and push it over the cloud row before the pull lands; and
    // starting late means `lastSeen` below is read *after* the pull's own
    // loadPortfolio call, so that write is already reflected in it instead
    // of looking like a new local edit that immediately echoes back up.
    if (pullCompleteForUserId !== user.id) return;

    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeen = usePortfolioStore.getState().lastSavedAt;

    const unsubscribe = usePortfolioStore.subscribe((state) => {
      if (state.lastSavedAt === lastSeen) return;
      lastSeen = state.lastSavedAt;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const portfolio = usePortfolioStore.getState().portfolio;
        void supabase
          .from("portfolios")
          .upsert(
            {
              user_id: user.id,
              ...(householdId ? { household_id: householdId } : {}),
              portfolio,
              updated_at: new Date().toISOString(),
            },
            householdId ? { onConflict: "household_id" } : undefined
          )
          .then(({ error }) => {
            if (error) console.warn("Failed to sync portfolio to the cloud.", error);
          });
      }, SYNC_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [user, hasHydrated, householdId, householdResolved, pullCompleteForUserId]);

  return { cloudSyncReady: !user || pullCompleteForUserId === user.id };
}
