"use client";

import { useEffect, useRef, useState } from "react";
import { portfolioSchema } from "@/domain/portfolio";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { useAuth } from "@/components/auth/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { getHouseholdId } from "@/lib/supabase/household";
import { safeToPush, shouldAcceptCloudLedger } from "@/lib/portfolio/syncSafety";

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

/**
 * Mounted once near the root of the portfolio tool. A no-op while signed out;
 * while signed in it pulls the cloud portfolio on sign-in (cloud wins) and
 * pushes local edits up on a short debounce, keyed off `lastSavedAt`.
 *
 * ## Why the gating below is as careful as it is
 *
 * On 2026-08-31 this hook destroyed a real ledger, and the shape of that
 * failure is what the two guards here exist to prevent.
 *
 * The push used to go live as soon as the pull *finished*, which is not the
 * same as the pull having *worked*: the flag was set from a `finally`, so a
 * failed request, or a cloud row the schema rejected, opened the gate just as
 * readily as a successful load. Land on a browser whose local copy is empty --
 * a new device, cleared site data, a first load after the store moved to
 * IndexedDB -- have the pull fail, and the local state is now an empty
 * portfolio with a live push behind it. Nobody has to touch anything for the
 * next part: the quote-refresh writeback stamps `lastSavedAt` on its own
 * within a second or two of the prices landing, and the empty portfolio goes
 * up over the real one.
 *
 * So there are two independent gates now, and both have to hold:
 *
 *  1. `pullOutcome === "ok"` -- the push only ever runs behind a pull that
 *     actually returned a portfolio (or established there was none to return).
 *  2. `safeToPush` -- an empty ledger is refused outright unless this session
 *     has *seen* a non-empty one, which is the difference between "the user
 *     deleted everything" and "this browser never loaded anything".
 *
 * The first alone would have been enough for the incident above. The second is
 * there because the first depends on correctly classifying every failure, and
 * a guard that only works when the error handling is perfect is not a guard.
 */
export function usePortfolioCloudSync(): { cloudSyncReady: boolean } {
  const { user } = useAuth();
  const hasHydrated = usePortfolioStore((s) => s.hasHydrated);
  const loadPortfolio = usePortfolioStore((s) => s.loadPortfolio);
  const { householdId, resolved: householdResolved } = useHouseholdId(user?.id, user?.email);
  const pulledForUserId = useRef<string | null>(null);
  const [pullOutcome, setPullOutcome] = useState<"pending" | "ok" | "failed">("pending");

  /**
   * Whether a ledger with anything in it has been in the store this session,
   * from any source -- local storage, the cloud pull, an import, a restore.
   *
   * This is what tells a real deletion apart from a browser that never loaded.
   * Tracked as a subscription rather than read at push time because the store
   * can pass through a populated state and back out of it, and it is the
   * *having been there* that matters.
   */
  const sawTransactions = useRef(false);
  useEffect(() => {
    const note = (count: number) => {
      if (count > 0) sawTransactions.current = true;
    };
    note(usePortfolioStore.getState().portfolio.transactions.length);
    return usePortfolioStore.subscribe((state) => note(state.portfolio.transactions.length));
  }, []);

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
          // Deliberately not "ok". Keeping the local portfolio is right, but
          // it must not be pushed: this branch cannot tell a network blip from
          // a row that is genuinely unreachable, and the local copy behind it
          // may be empty for reasons that have nothing to do with the user.
          console.warn("Failed to load cloud portfolio; keeping local portfolio and not syncing.", error);
          setPullOutcome("failed");
          return;
        }

        if (data?.portfolio) {
          const result = portfolioSchema.safeParse(data.portfolio);
          if (result.success) {
            const local = usePortfolioStore.getState().portfolio;
            if (
              !shouldAcceptCloudLedger(
                result.data.transactions.length,
                local.transactions.length,
              )
            ) {
              // The cloud row holds no transactions and this browser does.
              // Keeping the local copy leaves the ordinary push to repair the
              // cloud, rather than letting an empty row erase the last copy of
              // the ledger and then spread that emptiness to every other
              // device that loads after it.
              console.warn(
                "Cloud portfolio has no transactions but this browser does; keeping the local ledger and syncing it back up.",
              );
              setPullOutcome("ok");
              return;
            }
            loadPortfolio(result.data);
            setPullOutcome("ok");
            return;
          }
          console.warn(
            "Cloud portfolio failed validation; keeping local portfolio and not syncing.",
            result.error,
          );
          setPullOutcome("failed");
          return;
        }

        // No cloud row yet -- push the current local portfolio up as the first
        // copy, so this device's local data becomes the seed instead of being
        // silently shadowed by an empty cloud row. Still subject to the same
        // emptiness guard: seeding the cloud with nothing helps nobody, and on
        // a household row it would shadow a spouse's ledger.
        const localPortfolio = usePortfolioStore.getState().portfolio;
        if (safeToPush(localPortfolio.transactions.length, sawTransactions.current)) {
          await supabase.from("portfolios").upsert(
            {
              user_id: user.id,
              ...(householdId ? { household_id: householdId } : {}),
              portfolio: localPortfolio,
              updated_at: new Date().toISOString(),
            },
            householdId ? { onConflict: "household_id" } : undefined,
          );
        }
        setPullOutcome("ok");
      } catch (thrown) {
        console.warn("Cloud portfolio sync could not start; keeping local portfolio.", thrown);
        setPullOutcome("failed");
      }
    })();
  }, [user, hasHydrated, householdId, householdResolved, loadPortfolio]);

  useEffect(() => {
    if (!user || !hasHydrated || !householdResolved) return;
    // Only behind a pull that actually worked. See the header comment.
    if (pullOutcome !== "ok") return;

    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeen = usePortfolioStore.getState().lastSavedAt;

    const unsubscribe = usePortfolioStore.subscribe((state) => {
      if (state.lastSavedAt === lastSeen) return;
      lastSeen = state.lastSavedAt;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const portfolio = usePortfolioStore.getState().portfolio;

        if (!safeToPush(portfolio.transactions.length, sawTransactions.current)) {
          console.warn(
            "Refusing to sync an empty portfolio over the cloud copy: this session never held any transactions, so the local ledger is missing rather than cleared.",
          );
          return;
        }

        void supabase
          .from("portfolios")
          .upsert(
            {
              user_id: user.id,
              ...(householdId ? { household_id: householdId } : {}),
              portfolio,
              updated_at: new Date().toISOString(),
            },
            householdId ? { onConflict: "household_id" } : undefined,
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
  }, [user, hasHydrated, householdId, householdResolved, pullOutcome]);

  return { cloudSyncReady: !user || pullOutcome === "ok" };
}
