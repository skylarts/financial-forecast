"use client";

import { useEffect, useRef, useState } from "react";
import { portfolioSchema } from "@/domain/portfolio";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { useAuth } from "@/components/auth/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { getHouseholdId } from "@/lib/supabase/household";
import type { Transaction } from "@/domain/portfolio";
import {
  chunked,
  diffTransactions,
  snapshotOf,
} from "@/lib/portfolio/transactionSync";

const SYNC_DEBOUNCE_MS = 1500;

/** Untyped on purpose: the generated Supabase types don't cover the tables this
 *  file creates, and threading a generic through every call here would add
 *  noise without adding safety over the runtime checks already present. */
type Supabase = ReturnType<typeof createClient>;

/**
 * Every transaction row for one portfolio, paged out of the table.
 *
 * PostgREST caps a response at 1,000 rows regardless of what is asked for, so
 * a hundred-thousand-row ledger has to be walked rather than fetched. Stopping
 * on the first short page is what ends the loop.
 */
async function fetchCloudTransactions(
  supabase: Supabase,
  scopeId: string,
): Promise<Transaction[] | null> {
  const PAGE = 1000;
  const rows: Transaction[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("portfolio_transactions")
      .select("data")
      .eq("scope_id", scopeId)
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.warn("Failed to read cloud transactions; keeping local ledger.", error);
      return null;
    }
    for (const row of data ?? []) rows.push((row as { data: Transaction }).data);
    if ((data?.length ?? 0) < PAGE) break;
  }
  return rows;
}

/**
 * Writes a portfolio to the cloud, sending only the transactions that changed.
 *
 * The accounts and securities still go up whole, because they are small and
 * change together; the transactions are the only part that grows without
 * bound. `previous` is what the last push left there -- pass an empty map to
 * force a full backfill, which is what a first sync after this rollout does.
 *
 * Returns whether the push fully succeeded, so the caller only advances its
 * snapshot when the cloud really did get everything. A partial failure leaves
 * the snapshot alone and the next push retries the same rows.
 */
async function pushPortfolio(
  supabase: Supabase,
  userId: string,
  householdId: string | null,
  portfolio: { accounts: unknown; securities: unknown; transactions: Transaction[]; id: string },
  previous: ReadonlyMap<string, string> = new Map(),
): Promise<boolean> {
  const { upserts, deletes } = diffTransactions(portfolio.transactions, previous);
  const owner = { user_id: userId, ...(householdId ? { household_id: householdId } : {}) };
  // Spouses share one ledger, so rows are keyed by the household when there is
  // one. Keying by the writer instead would give the same transaction two rows
  // -- one per spouse -- and the shared read would count it twice.
  const scopeId = householdId ?? userId;

  for (const chunk of chunked(upserts)) {
    const { error } = await supabase.from("portfolio_transactions").upsert(
      chunk.map((tx) => ({
        ...owner,
        scope_id: scopeId,
        id: tx.id,
        data: tx,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "scope_id,id" },
    );
    if (error) {
      console.warn("Failed to sync transactions to the cloud.", error);
      return false;
    }
  }

  for (const chunk of chunked(deletes)) {
    const { error } = await supabase
      .from("portfolio_transactions")
      .delete()
      .eq("scope_id", scopeId)
      .in("id", chunk);
    if (error) {
      console.warn("Failed to remove deleted transactions from the cloud.", error);
      return false;
    }
  }

  // The blob keeps the accounts and securities, and an empty transaction list:
  // leaving the old copy in place would double the storage and give a future
  // reader two disagreeing answers about the same ledger.
  const { error } = await supabase.from("portfolios").upsert(
    {
      ...owner,
      portfolio: { ...portfolio, transactions: [] },
      transactions_migrated: true,
      updated_at: new Date().toISOString(),
    },
    householdId ? { onConflict: "household_id" } : undefined,
  );
  if (error) {
    console.warn("Failed to sync portfolio to the cloud.", error);
    return false;
  }
  return true;
}


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
  /**
   * What the cloud held at the end of the last successful push, by transaction
   * id. The next push diffs against this instead of re-sending the ledger, and
   * an empty map means "everything is new", which is exactly right for a first
   * sync or a backfill.
   */
  const remoteSnapshot = useRef<Map<string, string>>(new Map());
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
          .select("portfolio, transactions_migrated")
          .eq(filterColumn, filterValue)
          .maybeSingle();

        if (error) {
          console.warn("Failed to load cloud portfolio; keeping local portfolio.", error);
          return;
        }

        if (data?.portfolio) {
          // Transactions live in their own table once this portfolio has been
          // migrated; the blob's own list is left empty from then on. Reading
          // the blob's copy for an un-migrated row is what makes the rollout
          // seamless -- the first push after this deploy backfills the table.
          const rows = data.transactions_migrated
            ? await fetchCloudTransactions(supabase, householdId ?? user.id)
            : null;
          const merged =
            rows === null
              ? data.portfolio
              : { ...(data.portfolio as object), transactions: rows };

          const result = portfolioSchema.safeParse(merged);
          if (result.success) {
            loadPortfolio(result.data);
            remoteSnapshot.current = snapshotOf(result.data.transactions);
            return;
          }
          console.warn("Cloud portfolio failed validation; keeping local portfolio.", result.error);
          return;
        }

        // No cloud row yet -- push the current local portfolio up as the
        // first copy, so this device's local data becomes the seed instead
        // of being silently shadowed by an empty cloud row.
        const localPortfolio = usePortfolioStore.getState().portfolio;
        await pushPortfolio(supabase, user.id, householdId, localPortfolio);
        remoteSnapshot.current = snapshotOf(localPortfolio.transactions);
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
        void pushPortfolio(supabase, user.id, householdId, portfolio, remoteSnapshot.current).then(
          (pushed) => {
            if (pushed) remoteSnapshot.current = snapshotOf(portfolio.transactions);
          },
        );
      }, SYNC_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [user, hasHydrated, householdId, householdResolved, pullCompleteForUserId]);

  return { cloudSyncReady: !user || pullCompleteForUserId === user.id };
}
