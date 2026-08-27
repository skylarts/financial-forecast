"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { nanoid } from "nanoid";
import {
  normalizeSymbol,
  portfolioAccountSchema,
  portfolioSchema,
  securitySchema,
  type Portfolio,
  type PortfolioAccount,
  type Security,
  type Transaction,
} from "@/domain/portfolio";
import type { DraftTransaction } from "@/lib/portfolio/importer";
import { withAssignedLotIds } from "@/lib/portfolio/lotAssignment";
import { withCanonicalSymbols } from "@/lib/portfolio/canonicalSymbols";
import { accountFamilyIds, hasSleeves } from "@/lib/portfolio/accountTree";
import { sleeveTypeFor, TAX_SOURCE_SLEEVES } from "@/lib/portfolio/taxSource";
import { buildLotLedger } from "@/engine/portfolio/lots";

const STORAGE_KEY = "portfolio-tracker";

/**
 * Everything a ledger passes through on its way into the store, whatever door
 * it came in by. Symbols are canonicalised before lots are assigned, so a
 * generated lot id names the contract the way the rest of the app will.
 */
function tidy(portfolio: Portfolio): Portfolio {
  return withAssignedLotIds(withCanonicalSymbols(withMigratedAccounts(withMigratedSecurities(portfolio))));
}

/**
 * Brings a stored security up to the current shape.
 *
 * Every field the classification work added -- `exposures`, `instrumentType`,
 * `instrumentTypeSource`, `themes` -- has a default, but only a schema parse
 * applies one. A security saved before this file existed reads back as a
 * plain object with none of them, and the classify-holdings editor reads
 * straight off the record without an optional-chain to fall back on, the same
 * way it always has for `assetClass`. Without this, every pre-existing
 * portfolio throws the moment that editor renders.
 */
function withMigratedSecurities(portfolio: Portfolio): Portfolio {
  return {
    ...portfolio,
    securities: portfolio.securities.map((security) => securitySchema.parse(security)),
  };
}

/**
 * Brings a stored account up to the current shape.
 *
 * Only the accounts, and only through the schema, which applies the defaults a
 * save written before a field existed cannot carry. The one that matters today
 * is cash: accounts used to store a hand-typed *current* balance, and it is
 * deliberately dropped rather than migrated -- the ledger derives that balance
 * now, so keeping the old number as an opening balance would count the same
 * dollars twice, on top of a figure that was already stale by however long it
 * had been since anyone retyped it.
 */
function withMigratedAccounts(portfolio: Portfolio): Portfolio {
  return {
    ...portfolio,
    accounts: portfolio.accounts.map((account) => portfolioAccountSchema.parse(account)),
  };
}

const emptyPortfolio: Portfolio = {
  id: "local-portfolio",
  accounts: [],
  transactions: [],
  securities: [],
};

interface PortfolioState {
  portfolio: Portfolio;
  /** Bumped on every mutation; the cloud-sync hook watches this to know when to push. */
  lastSavedAt: number;
  hasHydrated: boolean;
  setHasHydrated: (value: boolean) => void;

  addAccount: (account: Omit<PortfolioAccount, "id">) => string;
  updateAccount: (id: string, patch: Partial<Omit<PortfolioAccount, "id">>) => void;
  /** Also removes that account's transactions -- orphaned rows would keep
   *  contributing to totals with nothing on screen explaining them -- and any
   *  sleeves beneath it, along with theirs. A sleeve only means anything as a
   *  subdivision of its parent, so leaving one behind would strand an account
   *  whose name no longer refers to anything. */
  removeAccount: (id: string) => void;

  addTransaction: (tx: Omit<Transaction, "id">) => string;
  /**
   * Appends many rows in one write, spanning accounts. Distinct from
   * `importTransactions`, which stamps a single account and a batch id --
   * generated dividends belong to whichever account held the shares, and
   * looping `addTransaction` would re-tidy the whole ledger once per row.
   */
  addTransactions: (txs: readonly Omit<Transaction, "id">[]) => number;
  updateTransaction: (id: string, patch: Partial<Omit<Transaction, "id">>) => void;
  removeTransaction: (id: string) => void;
  /**
   * Drops many rows in one write. Clearing a ledger to re-import a corrected
   * file is thousands of rows, and looping `removeTransaction` would re-tidy
   * the whole portfolio once per row. Returns how many actually went.
   */
  removeTransactions: (ids: readonly string[]) => number;
  /**
   * Writes one import as a single batch, each row carrying the account it was
   * routed to. Returns the batch id, so a bad import can be rolled back
   * wholesale.
   *
   * Rows name their own account rather than the batch naming one, because a
   * split workplace account's statement fans out across its sleeves: the money
   * source printed over each block of fund activity is what decides which pot
   * the row lands in, and that varies row by row within one file.
   */
  importTransactions: (rows: readonly { accountId: string; draft: DraftTransaction }[]) => string;
  undoImport: (batchId: string) => number;

  upsertSecurity: (security: Security) => void;
  /**
   * `adoptOwnerId` lets the caller carry the forecast account's owner across
   * onto a portfolio account that doesn't have one yet -- an explicit owner
   * already set always wins, so pass it as `undefined` (not `null`) when
   * there's nothing to adopt or the account already has an owner.
   */
  linkForecastAccount: (
    portfolioAccountId: string,
    forecastAccountId: string | null,
    adoptOwnerId?: string | null,
  ) => void;

  /**
   * Turns a workplace account into a split one: two sleeves, pre-tax and Roth,
   * each typed so it carries the right tax treatment into its own forecast
   * account.
   *
   * Existing transactions stay on the parent rather than being handed to a
   * sleeve. Which pot an already-imported row belongs to is a fact about the
   * statement it came from, not something this can infer, and guessing would
   * put Roth dollars in the pre-tax pot where nothing would ever flag them.
   * They show up as "unassigned" until they are moved.
   */
  splitByTaxSource: (id: string) => void;

  loadPortfolio: (portfolio: Portfolio) => void;
  importJson: (raw: unknown) => { ok: true } | { ok: false; error: string };
}

export const usePortfolioStore = create<PortfolioState>()(
  persist(
    (set, get) => {
      /** Every mutation funnels through here so no path can forget to stamp
       *  lastSavedAt and silently skip the cloud push -- and so no path can
       *  leave a transaction without a lot id, whether it arrived from the
       *  add form, an import, or an edit that cleared the field. */
      const mutate = (update: (portfolio: Portfolio) => Portfolio) =>
        set((state) => ({
          portfolio: tidy(update(state.portfolio)),
          lastSavedAt: Date.now(),
        }));

      return {
        portfolio: emptyPortfolio,
        lastSavedAt: 0,
        hasHydrated: false,
        setHasHydrated: (value) => set({ hasHydrated: value }),

        addAccount: (account) => {
          const id = nanoid();
          mutate((p) => ({ ...p, accounts: [...p.accounts, { ...account, id }] }));
          return id;
        },

        updateAccount: (id, patch) =>
          mutate((p) => ({
            ...p,
            accounts: p.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)),
          })),

        removeAccount: (id) =>
          mutate((p) => {
            const doomed = new Set(accountFamilyIds(p.accounts, id));
            return {
              ...p,
              accounts: p.accounts.filter((a) => !doomed.has(a.id)),
              transactions: p.transactions.filter((tx) => !doomed.has(tx.accountId)),
            };
          }),

        addTransaction: (tx) => {
          const id = nanoid();
          mutate((p) => ({
            ...p,
            transactions: [...p.transactions, { ...tx, id }],
          }));
          return id;
        },

        addTransactions: (txs) => {
          if (txs.length === 0) return 0;
          mutate((p) => ({
            ...p,
            transactions: [...p.transactions, ...txs.map((tx) => ({ ...tx, id: nanoid() }))],
          }));
          return txs.length;
        },

        updateTransaction: (id, patch) =>
          mutate((p) => ({
            ...p,
            transactions: p.transactions.map((tx) => (tx.id === id ? { ...tx, ...patch } : tx)),
          })),

        removeTransaction: (id) =>
          mutate((p) => ({ ...p, transactions: p.transactions.filter((tx) => tx.id !== id) })),

        removeTransactions: (ids) => {
          if (ids.length === 0) return 0;
          const doomed = new Set(ids);
          const before = get().portfolio.transactions.length;
          mutate((p) => ({ ...p, transactions: p.transactions.filter((tx) => !doomed.has(tx.id)) }));
          return before - get().portfolio.transactions.length;
        },

        importTransactions: (rows) => {
          const batchId = nanoid();
          mutate((p) => ({
            ...p,
            transactions: [
              ...p.transactions,
              ...rows.map(({ accountId, draft }) => ({
                ...draft,
                id: nanoid(),
                accountId,
                importBatchId: batchId,
              })),
            ],
          }));
          return batchId;
        },

        undoImport: (batchId) => {
          const before = get().portfolio.transactions.length;
          mutate((p) => ({
            ...p,
            transactions: p.transactions.filter((tx) => tx.importBatchId !== batchId),
          }));
          return before - get().portfolio.transactions.length;
        },

        upsertSecurity: (security) => {
          const symbol = normalizeSymbol(security.symbol);
          mutate((p) => {
            const exists = p.securities.some((s) => normalizeSymbol(s.symbol) === symbol);
            return {
              ...p,
              securities: exists
                ? p.securities.map((s) =>
                    normalizeSymbol(s.symbol) === symbol ? { ...security, symbol } : s,
                  )
                : [...p.securities, { ...security, symbol }],
            };
          });
        },

        linkForecastAccount: (portfolioAccountId, forecastAccountId, adoptOwnerId) =>
          mutate((p) => ({
            ...p,
            accounts: p.accounts.map((a) =>
              a.id === portfolioAccountId
                ? {
                    ...a,
                    forecastAccountId,
                    ...(a.ownerId === null && adoptOwnerId !== undefined
                      ? { ownerId: adoptOwnerId }
                      : {}),
                  }
                : a,
            ),
          })),

        splitByTaxSource: (id) =>
          mutate((p) => {
            const parent = p.accounts.find((a) => a.id === id);
            // Already split, or itself a sleeve: the tree is one level deep,
            // and re-splitting would strand the sleeves that exist.
            if (!parent || parent.parentAccountId !== null || hasSleeves(p.accounts, id)) return p;

            const sleeves = TAX_SOURCE_SLEEVES.map((sleeve) => ({
              ...parent,
              id: nanoid(),
              name: sleeve.name,
              type: sleeveTypeFor(parent.type, sleeve.source),
              parentAccountId: parent.id,
              // Each sleeve links to its own forecast account, and until the
              // user picks one there is nothing honest to point at.
              forecastAccountId: null,
              syncToForecast: true,
              // Opening cash seeded the parent's ledger and still does; the
              // sleeves start from their own first rows.
              openingCashBalance: 0,
            }));

            return {
              ...p,
              accounts: [
                // The parent stops syncing the moment it has sleeves, so a link
                // left on it would be stored, invisible, and wrong. Dropping it
                // costs one dropdown; keeping it risks pushing the whole
                // account's value into whichever half it happened to name.
                ...p.accounts.map((a) => (a.id === id ? { ...a, forecastAccountId: null } : a)),
                ...sleeves,
              ],
            };
          }),

        loadPortfolio: (portfolio) =>
          set({ portfolio: tidy(portfolio), lastSavedAt: Date.now() }),

        importJson: (raw) => {
          const result = portfolioSchema.safeParse(raw);
          if (!result.success) {
            return { ok: false, error: "That file isn't a portfolio backup this app can read." };
          }
          set({ portfolio: tidy(result.data), lastSavedAt: Date.now() });
          return { ok: true };
        },
      };
    },
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ portfolio: state.portfolio, lastSavedAt: state.lastSavedAt }),
      /**
       * Backfills lot ids and canonical symbols onto a ledger saved before
       * either existed -- which is every ledger imported from a brokerage
       * export. Done here rather than as a one-shot migration so a portfolio
       * arriving from anywhere -- an old browser, a restored backup -- comes
       * back fully identified and spelled the way the quote feed spells it.
       */
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<PortfolioState>) };
        return { ...merged, portfolio: tidy(merged.portfolio) };
      },
      onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
    },
  ),
);

/**
 * Symbols the ledger currently holds a position in, for prefetching quotes.
 *
 * Scoped to open lots rather than every symbol a transaction ever named: a
 * fully sold stock or an expired option has nothing left to price, so asking
 * the feed about it only burns rate limit and -- for an option the feed will
 * never answer again -- surfaces a permanent, meaningless "no quote" warning
 * for a position that's already closed.
 */
export function symbolsInPortfolio(portfolio: Portfolio): string[] {
  const { openLots } = buildLotLedger(portfolio.transactions);
  return [...new Set(openLots.map((lot) => lot.symbol))];
}
