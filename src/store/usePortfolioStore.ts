"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { nanoid } from "nanoid";
import {
  normalizeSymbol,
  portfolioSchema,
  type Portfolio,
  type PortfolioAccount,
  type Security,
  type Transaction,
} from "@/domain/portfolio";
import type { DraftTransaction } from "@/lib/portfolio/importer";

const STORAGE_KEY = "portfolio-tracker";

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
   *  contributing to totals with nothing on screen explaining them. */
  removeAccount: (id: string) => void;

  addTransaction: (tx: Omit<Transaction, "id">) => string;
  updateTransaction: (id: string, patch: Partial<Omit<Transaction, "id">>) => void;
  removeTransaction: (id: string) => void;
  /** Returns the batch id, so a bad import can be rolled back wholesale. */
  importTransactions: (accountId: string, drafts: readonly DraftTransaction[]) => string;
  undoImport: (batchId: string) => number;

  upsertSecurity: (security: Security) => void;
  linkForecastAccount: (portfolioAccountId: string, forecastAccountId: string | null) => void;

  loadPortfolio: (portfolio: Portfolio) => void;
  importJson: (raw: unknown) => { ok: true } | { ok: false; error: string };
}

export const usePortfolioStore = create<PortfolioState>()(
  persist(
    (set, get) => {
      /** Every mutation funnels through here so no path can forget to stamp
       *  lastSavedAt and silently skip the cloud push. */
      const mutate = (update: (portfolio: Portfolio) => Portfolio) =>
        set((state) => ({ portfolio: update(state.portfolio), lastSavedAt: Date.now() }));

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
          mutate((p) => ({
            ...p,
            accounts: p.accounts.filter((a) => a.id !== id),
            transactions: p.transactions.filter((tx) => tx.accountId !== id),
          })),

        addTransaction: (tx) => {
          const id = nanoid();
          mutate((p) => ({
            ...p,
            transactions: [...p.transactions, { ...tx, id }],
          }));
          return id;
        },

        updateTransaction: (id, patch) =>
          mutate((p) => ({
            ...p,
            transactions: p.transactions.map((tx) => (tx.id === id ? { ...tx, ...patch } : tx)),
          })),

        removeTransaction: (id) =>
          mutate((p) => ({ ...p, transactions: p.transactions.filter((tx) => tx.id !== id) })),

        importTransactions: (accountId, drafts) => {
          const batchId = nanoid();
          mutate((p) => ({
            ...p,
            transactions: [
              ...p.transactions,
              ...drafts.map((draft) => ({ ...draft, id: nanoid(), accountId, importBatchId: batchId })),
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

        linkForecastAccount: (portfolioAccountId, forecastAccountId) =>
          mutate((p) => ({
            ...p,
            accounts: p.accounts.map((a) =>
              a.id === portfolioAccountId ? { ...a, forecastAccountId } : a,
            ),
          })),

        loadPortfolio: (portfolio) => set({ portfolio, lastSavedAt: Date.now() }),

        importJson: (raw) => {
          const result = portfolioSchema.safeParse(raw);
          if (!result.success) {
            return { ok: false, error: "That file isn't a portfolio backup this app can read." };
          }
          set({ portfolio: result.data, lastSavedAt: Date.now() });
          return { ok: true };
        },
      };
    },
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ portfolio: state.portfolio, lastSavedAt: state.lastSavedAt }),
      onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
    },
  ),
);

/** Every symbol the ledger touches, for prefetching quotes. */
export function symbolsInPortfolio(portfolio: Portfolio): string[] {
  const symbols = new Set<string>();
  for (const tx of portfolio.transactions) {
    if (tx.symbol) symbols.add(normalizeSymbol(tx.symbol));
  }
  return [...symbols];
}
