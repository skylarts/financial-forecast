import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { nanoid } from "nanoid";
import type {
  Account,
  ExpenseBaseline,
  ForecastSettings,
  IncomeSource,
  Person,
  Plan,
  Scenario,
  ScenarioEvent,
} from "@/domain";
import { planSchema } from "@/domain";
import { mockScenario } from "@/lib/mockScenario";
import { makeBlankScenario } from "@/lib/blankScenario";
import { looksLikeV2Plan, migrateV2PlanToV3 } from "@/lib/migrateV2Plan";

const defaultPlan: Plan = {
  id: "local-plan",
  scenarios: [mockScenario],
  activeScenarioId: mockScenario.id,
};

const PLAN_STORAGE_KEY = "forecast-plan";

// Captured synchronously at module load -- before persist's rehydration can
// write anything back to storage (that write is deferred at least a tick, to
// avoid an SSR hydration mismatch; see the loading gate in page.tsx). This is
// the only reliable way to tell whether this browser already had a saved
// plan, used to decide whether the first-run setup wizard should auto-open.
const hadPersistedPlanAtLoad =
  typeof window !== "undefined" && window.localStorage.getItem(PLAN_STORAGE_KEY) !== null;

/** True if this browser already had a saved plan before this page load. */
export function hadExistingPlanOnLoad(): boolean {
  return hadPersistedPlanAtLoad;
}

interface PlanState {
  plan: Plan;
  lastSavedAt: number;
  hasHydrated: boolean;
  setHasHydrated: (value: boolean) => void;
  activeScenario: () => Scenario;
  setActiveScenarioId: (id: string) => void;

  // Scenario comparison (UI-only, not persisted)
  compareScenarioId: string | null;
  setCompareScenarioId: (id: string | null) => void;

  // Scenario management
  duplicateScenario: (sourceId: string, newName: string) => string;
  addBlankScenario: (newName: string) => string;
  renameScenario: (id: string, name: string) => void;
  deleteScenario: (id: string) => void;

  // Household
  addPerson: (person: Omit<Person, "id">) => void;
  updatePerson: (id: string, person: Omit<Person, "id">) => void;
  /** Returns false (without removing) if the person is still referenced by an
   * account, income source, or event -- deleting them silently would stop
   * modeling things like RMDs on their accounts with no visible signal. */
  removePerson: (id: string) => boolean;

  // Settings
  updateSettings: (settings: ForecastSettings) => void;

  // Backup / restore
  /** Validates `raw` against planSchema before replacing anything -- a bad or
   * corrupt file can't wipe out the current plan. A file in the older
   * (pre-streamlining) shape is auto-migrated first -- see migrateV2Plan --
   * so restoring an existing real backup doesn't silently drop its
   * money-flow routing (spending accounts, surplus targets, withdrawal
   * order) or its income_change/expense_change/windfall events. */
  importPlan: (raw: unknown) => { ok: true; migrated: boolean } | { ok: false; error: string };
  /** Replaces the plan with one already known to be valid (e.g. fetched from
   * the cloud on sign-in) -- unlike importPlan, no parsing/migration needed. */
  loadPlan: (plan: Plan) => void;

  // Accounts
  addAccount: (account: Omit<Account, "id">) => void;
  updateAccount: (id: string, account: Omit<Account, "id">) => void;
  /** Returns false (without removing) if the account is still referenced as a
   * payment/deposit/transfer account by an expense, income source, or event --
   * deleting it would silently drop that cashflow from the engine with no warning. */
  removeAccount: (id: string) => boolean;

  // Income
  addIncomeSource: (income: Omit<IncomeSource, "id">) => void;
  updateIncomeSource: (id: string, income: Omit<IncomeSource, "id">) => void;
  /** No external entity can reference an income source by id anymore (temporary
   * adjustments live on the source itself), so deletion always succeeds. */
  removeIncomeSource: (id: string) => void;

  // Expenses
  addExpense: (expense: Omit<ExpenseBaseline, "id">) => void;
  updateExpense: (id: string, expense: Omit<ExpenseBaseline, "id">) => void;
  /** No external entity can reference an expense by id anymore (temporary
   * adjustments live on the expense itself), so deletion always succeeds. */
  removeExpense: (id: string) => void;

  // Events
  addEvent: (event: Omit<ScenarioEvent, "id">) => void;
  updateEvent: (id: string, event: Omit<ScenarioEvent, "id">) => void;
  removeEvent: (id: string) => void;
}

function withActiveScenario(
  set: (fn: (state: PlanState) => Partial<PlanState>) => void,
  updater: (scenario: Scenario) => Scenario
) {
  set((state) => ({
    plan: {
      ...state.plan,
      scenarios: state.plan.scenarios.map((s) =>
        s.id === state.plan.activeScenarioId ? updater(s) : s
      ),
    },
    lastSavedAt: Date.now(),
  }));
}

export const usePlanStore = create<PlanState>()(
  persist(
    (set, get) => ({
      plan: defaultPlan,
      lastSavedAt: 0,
      hasHydrated: false,
      setHasHydrated: (value) => set(() => ({ hasHydrated: value })),

      activeScenario: () => {
        const { plan } = get();
        return plan.scenarios.find((s) => s.id === plan.activeScenarioId) ?? plan.scenarios[0];
      },

      setActiveScenarioId: (id) =>
        set((state) => ({ plan: { ...state.plan, activeScenarioId: id } })),

      compareScenarioId: null,
      setCompareScenarioId: (id) => set(() => ({ compareScenarioId: id })),

      duplicateScenario: (sourceId, newName) => {
        const source = get().plan.scenarios.find((s) => s.id === sourceId);
        if (!source) return sourceId;
        const newId = nanoid();
        const copy: Scenario = {
          ...source,
          id: newId,
          name: newName,
          createdFromScenarioId: source.id,
        };
        set((state) => ({
          plan: { ...state.plan, scenarios: [...state.plan.scenarios, copy], activeScenarioId: newId },
          lastSavedAt: Date.now(),
        }));
        return newId;
      },

      addBlankScenario: (newName) => {
        const blank = { ...makeBlankScenario(newName) };
        set((state) => ({
          plan: { ...state.plan, scenarios: [...state.plan.scenarios, blank], activeScenarioId: blank.id },
          lastSavedAt: Date.now(),
        }));
        return blank.id;
      },

      renameScenario: (id, name) =>
        set((state) => ({
          plan: {
            ...state.plan,
            scenarios: state.plan.scenarios.map((s) => (s.id === id ? { ...s, name } : s)),
          },
          lastSavedAt: Date.now(),
        })),

      deleteScenario: (id) =>
        set((state) => {
          const remaining = state.plan.scenarios.filter((s) => s.id !== id);
          if (remaining.length === 0) return state;
          const activeScenarioId =
            state.plan.activeScenarioId === id ? remaining[0].id : state.plan.activeScenarioId;
          return {
            plan: { ...state.plan, scenarios: remaining, activeScenarioId },
            compareScenarioId: state.compareScenarioId === id ? null : state.compareScenarioId,
            lastSavedAt: Date.now(),
          };
        }),

      addPerson: (person) =>
        withActiveScenario(set, (s) => ({
          ...s,
          household: { people: [...s.household.people, { ...person, id: nanoid() }] },
        })),

      updatePerson: (id, person) =>
        withActiveScenario(set, (s) => ({
          ...s,
          household: {
            people: s.household.people.map((p) => (p.id === id ? { ...person, id } : p)),
          },
        })),

      removePerson: (id) => {
        const scenario = get().activeScenario();
        const referenced =
          scenario.accounts.some((a) => a.ownerId === id) ||
          scenario.incomeSources.some((i) => i.ownerId === id) ||
          scenario.events.some((e) => "personId" in e && e.personId === id);
        if (referenced) return false;
        withActiveScenario(set, (s) => ({
          ...s,
          household: { people: s.household.people.filter((p) => p.id !== id) },
        }));
        return true;
      },

      updateSettings: (settings) => withActiveScenario(set, (s) => ({ ...s, settings })),

      importPlan: (raw) => {
        const migrated = looksLikeV2Plan(raw);
        const candidate = migrated ? migrateV2PlanToV3(raw) : raw;
        const result = planSchema.safeParse(candidate);
        if (!result.success) {
          return { ok: false, error: result.error.issues[0]?.message ?? "That file isn't a valid Forecast backup." };
        }
        set({ plan: result.data, lastSavedAt: Date.now() });
        return { ok: true, migrated };
      },

      loadPlan: (plan) => set({ plan, lastSavedAt: Date.now() }),

      addAccount: (account) =>
        withActiveScenario(set, (s) => ({ ...s, accounts: [...s.accounts, { ...account, id: nanoid() } as Account] })),

      updateAccount: (id, account) =>
        withActiveScenario(set, (s) => ({
          ...s,
          accounts: s.accounts.map((a) => (a.id === id ? ({ ...account, id } as Account) : a)),
        })),

      removeAccount: (id) => {
        const scenario = get().activeScenario();
        const account = scenario.accounts.find((a) => a.id === id);
        // Extra Savings is the one mandatory account in a scenario -- the
        // engine assumes exactly one always exists (see scenarioSchema's
        // auto-inject transform), so it can never be deleted, regardless of
        // whether anything else references it.
        if (account?.isExtraSavings) return false;
        const referenced =
          scenario.expenses.some((e) => e.paymentAccountId === id) ||
          scenario.incomeSources.some((i) => i.depositAccountId === id) ||
          scenario.events.some((e) => {
            switch (e.type) {
              case "buy_home":
                return e.downPaymentFromAccountId === id;
              case "have_a_kid":
                return e.paymentAccountId === id;
              case "custom_transfer":
                return e.fromAccountId === id || e.toAccountId === id;
              default:
                return false;
            }
          });
        if (referenced) return false;
        withActiveScenario(set, (s) => ({
          ...s,
          accounts: s.accounts.filter((a) => a.id !== id),
          // A deleted account's role in the money-flow waterfall is just
          // routing metadata, not a hard reference -- drop it from whichever
          // list it was in rather than blocking the deletion.
          settings: {
            ...s.settings,
            moneyFlow: {
              ...s.settings.moneyFlow,
              splitOrder: s.settings.moneyFlow.splitOrder.filter((stop) => stop.accountId !== id),
              drainOrder: s.settings.moneyFlow.drainOrder.filter((stop) => stop.accountId !== id),
            },
          },
        }));
        return true;
      },

      addIncomeSource: (income) =>
        withActiveScenario(set, (s) => ({ ...s, incomeSources: [...s.incomeSources, { ...income, id: nanoid() }] })),

      updateIncomeSource: (id, income) =>
        withActiveScenario(set, (s) => ({
          ...s,
          incomeSources: s.incomeSources.map((i) => (i.id === id ? { ...income, id } : i)),
        })),

      removeIncomeSource: (id) =>
        withActiveScenario(set, (s) => ({ ...s, incomeSources: s.incomeSources.filter((i) => i.id !== id) })),

      addExpense: (expense) =>
        withActiveScenario(set, (s) => ({ ...s, expenses: [...s.expenses, { ...expense, id: nanoid() }] })),

      updateExpense: (id, expense) =>
        withActiveScenario(set, (s) => ({
          ...s,
          expenses: s.expenses.map((e) => (e.id === id ? { ...expense, id } : e)),
        })),

      removeExpense: (id) =>
        withActiveScenario(set, (s) => ({ ...s, expenses: s.expenses.filter((e) => e.id !== id) })),

      addEvent: (event) =>
        withActiveScenario(set, (s) => ({ ...s, events: [...s.events, { ...event, id: nanoid() } as ScenarioEvent] })),

      updateEvent: (id, event) =>
        withActiveScenario(set, (s) => ({
          ...s,
          events: s.events.map((e) => (e.id === id ? ({ ...event, id } as ScenarioEvent) : e)),
        })),

      removeEvent: (id) =>
        withActiveScenario(set, (s) => ({ ...s, events: s.events.filter((e) => e.id !== id) })),
    }),
    {
      name: PLAN_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ plan: state.plan }),
      merge: (persisted, current) => {
        const candidate = (persisted as { plan?: unknown })?.plan;
        const result = planSchema.safeParse(candidate);
        if (!result.success) {
          console.warn("Persisted plan failed validation; starting fresh.", result.error);
          return current;
        }
        return { ...current, plan: result.data };
      },
      // Next.js SSRs the initial (default) state; localStorage only exists
      // client-side, so real data arrives one tick after mount. Gate
      // rendering on hasHydrated to avoid a hydration mismatch / content flash.
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);

if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
  // Dev-only console access for debugging, e.g. `__planStore.getState().addPerson(...)`.
  (window as unknown as { __planStore: typeof usePlanStore }).__planStore = usePlanStore;
}
