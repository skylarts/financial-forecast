"use client";

import { useEffect, useRef, useState } from "react";
import type { Plan } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { useSyncStatus } from "@/store/useSyncStatus";
import { useAuth } from "@/components/auth/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { getHouseholdId } from "@/lib/supabase/household";
import { normalizePlan, planHasContent } from "@/lib/planIO";
import { keepBrokenCopy, keepPlanCopy } from "@/lib/planRecovery";
import { cloudChangedSinceSeen, safeToPushPlan, shouldAcceptCloudPlan, type PullOutcome } from "@/lib/planSyncSafety";

const SYNC_DEBOUNCE_MS = 1500;

/** Resolves the signed-in user's household id (if their email is paired with
 * a spouse -- see supabase/household_linking.sql), so the plan row is keyed
 * off the household instead of the individual user. `resolved` stays false
 * until the lookup for the *current* user settles. */
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

interface CloudRow {
  plan: unknown;
  updated_at: string | null;
}

/**
 * Keeps the plan in this browser and the household's cloud row in step.
 *
 * Signed out, it does nothing. Signed in, it reads the cloud row once per
 * user, then pushes local edits on a short debounce. The rules that keep it
 * from destroying anything live in src/lib/planSyncSafety.ts and are applied
 * here in this order:
 *
 *  - nothing is pushed until a read has succeeded (or found no row);
 *  - an empty plan is never pushed unless this session saw a real one;
 *  - a cloud copy with no content never replaces a local one that has some;
 *  - every replacement keeps a copy of what it replaced first;
 *  - a push that would overwrite a copy saved elsewhere since our last read
 *    keeps that newer copy first, and says so.
 *
 * Returns `cloudSyncReady`: true immediately when signed out, true once the
 * read for the current user has settled either way.
 */
export function useCloudSync(): { cloudSyncReady: boolean } {
  const { user } = useAuth();
  const userId = user?.id;
  const email = user?.email;
  const hasHydrated = usePlanStore((s) => s.hasHydrated);
  const { householdId, resolved: householdResolved } = useHouseholdId(userId, email);
  const setSync = useSyncStatus((s) => s.setSync);
  const markSynced = useSyncStatus((s) => s.markSynced);
  const notify = useSyncStatus((s) => s.notify);

  const pullOutcome = useRef<PullOutcome>("not-started");
  const pullForUserId = useRef<string | null>(null);
  const [pullSettledFor, setPullSettledFor] = useState<string | null>(null);
  const lastSeenUpdatedAt = useRef<string | null>(null);
  const sessionSawContent = useRef(false);

  // Rule 2's memory: has a plan with content been in the store this session?
  useEffect(() => {
    const check = (plan: Plan) => {
      if (planHasContent(plan)) sessionSawContent.current = true;
    };
    check(usePlanStore.getState().plan);
    return usePlanStore.subscribe((state) => check(state.plan));
  }, []);

  useEffect(() => {
    if (!userId) {
      setSync("local");
      pullOutcome.current = "not-started";
      pullForUserId.current = null;
      lastSeenUpdatedAt.current = null;
    }
  }, [userId, setSync]);

  const rowFilter = (): { column: "household_id" | "user_id"; value: string } =>
    householdId ? { column: "household_id", value: householdId } : { column: "user_id", value: userId! };

  const upsertRow = async (plan: Plan): Promise<{ error: unknown; updatedAt: string }> => {
    const supabase = createClient();
    const updatedAt = new Date().toISOString();
    const { error } = await supabase.from("plans").upsert(
      {
        user_id: userId!,
        ...(householdId ? { household_id: householdId } : {}),
        plan,
        updated_at: updatedAt,
      },
      householdId ? { onConflict: "household_id" } : undefined
    );
    return { error, updatedAt };
  };

  const readRow = async (): Promise<{ row: CloudRow | null; error: unknown }> => {
    const supabase = createClient();
    const { column, value } = rowFilter();
    const { data, error } = await supabase.from("plans").select("plan, updated_at").eq(column, value).maybeSingle();
    return { row: (data as CloudRow | null) ?? null, error };
  };

  // --- the read, once per signed-in user ---------------------------------
  useEffect(() => {
    if (!userId || !hasHydrated || !householdResolved) return;
    if (pullForUserId.current === userId) return;
    pullForUserId.current = userId;
    pullOutcome.current = "in-flight";
    setSync("syncing");

    (async () => {
      try {
        const { row, error } = await readRow();
        if (error) {
          pullOutcome.current = "failed";
          setSync("error", "The cloud copy could not be read. Changes stay in this browser until it can be.");
          return;
        }

        const local = usePlanStore.getState().plan;
        const localHasContent = planHasContent(local);

        if (!row?.plan) {
          // No cloud row yet. Only a plan with something in it is worth
          // sending up as the first copy.
          pullOutcome.current = "empty";
          if (localHasContent) {
            const { error: pushError, updatedAt } = await upsertRow(local);
            if (pushError) {
              setSync("error", "The first cloud save failed. It will be retried on the next change.");
            } else {
              lastSeenUpdatedAt.current = updatedAt;
              markSynced();
            }
          } else {
            markSynced();
          }
          return;
        }

        const result = normalizePlan(row.plan);
        if (!result.ok) {
          pullOutcome.current = "failed";
          keepBrokenCopy(JSON.stringify(row.plan), `Cloud plan could not be loaded: ${result.error}`);
          setSync("error", `The cloud copy could not be loaded (${result.error}). A copy of it is kept under Data, Recover.`);
          return;
        }

        const cloudHasContent = planHasContent(result.plan);
        pullOutcome.current = "succeeded";
        lastSeenUpdatedAt.current = row.updated_at;

        if (shouldAcceptCloudPlan(cloudHasContent, localHasContent)) {
          const differs = JSON.stringify(local) !== JSON.stringify(result.plan);
          usePlanStore.getState().loadPlan(result.plan, "Replaced by the cloud copy on sign-in");
          if (localHasContent && differs) {
            notify("Loaded the household's cloud plan. The plan that was in this browser is kept under Data, Recover.", {
              ttlMs: 12_000,
            });
          }
          if (result.repairs.length) {
            usePlanStore.setState({ loadIssue: { kind: "repaired", repairs: result.repairs } });
          }
          markSynced();
        } else {
          // Cloud row exists but holds nothing; the local plan repairs it.
          const { error: pushError, updatedAt } = await upsertRow(local);
          if (pushError) setSync("error", "The cloud copy was empty and could not be repaired from this browser yet.");
          else {
            lastSeenUpdatedAt.current = updatedAt;
            markSynced();
          }
        }
      } finally {
        setPullSettledFor(userId);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, hasHydrated, householdId, householdResolved]);

  // --- the write, debounced, flushed on teardown ---------------------------
  useEffect(() => {
    if (!userId || !hasHydrated || !householdResolved) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeenSave = usePlanStore.getState().lastSavedAt;
    let inFlight = false;
    let again = false;

    const push = async () => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        const plan = usePlanStore.getState().plan;
        if (!safeToPushPlan(pullOutcome.current, planHasContent(plan), sessionSawContent.current)) {
          if (pullOutcome.current === "failed") {
            setSync("error", "Changes are kept in this browser; the cloud copy could not be read, so nothing is sent up.");
          }
          return;
        }
        setSync("syncing");
        // Someone else saved since we last looked? Keep their copy before
        // ours lands on top of it.
        const { row, error: readError } = await readRow();
        if (!readError && row && cloudChangedSinceSeen(row.updated_at, lastSeenUpdatedAt.current)) {
          const theirs = normalizePlan(row.plan);
          if (theirs.ok) {
            keepPlanCopy(theirs.plan, "replaced", `Cloud copy saved elsewhere at ${row.updated_at ?? "an unknown time"}, overwritten by this device`);
            notify("Another device saved this plan since it was last read here. Its version is kept under Data, Recover; this device's version is now the cloud copy.", {
              ttlMs: 15_000,
            });
          }
        }
        const { error, updatedAt } = await upsertRow(plan);
        if (error) {
          setSync("error", "The cloud save failed. It will be retried on the next change.");
        } else {
          lastSeenUpdatedAt.current = updatedAt;
          markSynced();
        }
      } finally {
        inFlight = false;
        if (again) {
          again = false;
          void push();
        }
      }
    };

    const unsubscribe = usePlanStore.subscribe((state) => {
      if (state.lastSavedAt === lastSeenSave) return;
      lastSeenSave = state.lastSavedAt;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void push();
      }, SYNC_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer) {
        // A pending edit must not be dropped because the session object
        // refreshed: send it now.
        clearTimeout(timer);
        timer = null;
        void push();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, hasHydrated, householdId, householdResolved, pullSettledFor]);

  // --- pick up a save made elsewhere when this tab comes back ---------------
  useEffect(() => {
    if (!userId || !hasHydrated || !householdResolved) return;
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      if (pullOutcome.current !== "succeeded" && pullOutcome.current !== "empty") return;
      const { row, error } = await readRow();
      if (error || !row?.plan) return;
      if (!cloudChangedSinceSeen(row.updated_at, lastSeenUpdatedAt.current)) return;
      const result = normalizePlan(row.plan);
      if (!result.ok) return;
      const local = usePlanStore.getState().plan;
      if (!shouldAcceptCloudPlan(planHasContent(result.plan), planHasContent(local))) return;
      lastSeenUpdatedAt.current = row.updated_at;
      usePlanStore.getState().loadPlan(result.plan, "Replaced by a newer cloud copy saved on another device");
      notify("Updated from the cloud: this plan was saved on another device. The previous version here is kept under Data, Recover.", {
        ttlMs: 12_000,
      });
      markSynced();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, hasHydrated, householdId, householdResolved]);

  return { cloudSyncReady: !userId || pullSettledFor === userId };
}
