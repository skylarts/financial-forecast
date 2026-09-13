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
import { mockScenario } from "@/lib/mockScenario";
import { makeBlankScenario } from "@/lib/blankScenario";
import { normalizePlan, normalizeScenario, planHasContent, PLAN_SCHEMA_VERSION, type NormalizeOk } from "@/lib/planIO";
import { isShrinkingChange, keepBrokenCopy, keepPlanCopy } from "@/lib/planRecovery";

/**
 * A brand-new browser starts with one empty scenario, not the fictional
 * sample household. The sample is one click away ("Load sample plan") and
 * never mixes with real data.
 */
function makeEmptyPlan(): Plan {
  const blank = makeBlankScenario("My Plan");
  return { id: "local-plan", scenarios: [blank], activeScenarioId: blank.id, schemaVersion: PLAN_SCHEMA_VERSION };
}

const defaultPlan: Plan = makeEmptyPlan();

const PLAN_STORAGE_KEY = "forecast-plan";

/**
 * Something the load had to do that a person should know about: a saved
 * plan that could not be read (its bytes are kept under `copyKey`), or
 * references that were repaired on the way in.
 */
export type LoadIssue =
  | { kind: "broken"; message: string; copyKey: string | null }
  | { kind: "repaired"; repairs: string[] };

export interface PendingUndo {
  /** "Deleted Joint Brokerage" -- shown on the toast. */
  label: string;
  /** The plan as it was just before the delete. */
  plan: Plan;
}

interface PlanState {
  plan: Plan;
  lastSavedAt: number;
  hasHydrated: boolean;
  setHasHydrated: (value: boolean) => void;
  loadIssue: LoadIssue | null;
  clearLoadIssue: () => void;
  pendingUndo: PendingUndo | null;
  /** Put the plan back as it was before the last delete. */
  undoLastDelete: () => void;
  clearPendingUndo: () => void;

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
  /** Adds the fictional sample household; replaces the empty starting scenario when nothing has been entered yet. */
  loadSamplePlan: () => void;

  // Household
  addPerson: (person: Omit<Person, "id">) => void;
  updatePerson: (id: string, person: Omit<Person, "id">) => void;
  /** Returns false (without removing) if the person is still referenced by an
   * account, income source, or event. */
  removePerson: (id: string) => boolean;

  // Settings
  updateSettings: (settings: ForecastSettings) => void;

  // Backup / restore
  /**
   * Replaces the whole plan with the contents of a backup file, after the
   * same migrate-validate-repair pass every other load uses. The current plan
   * is kept as a recovery copy first. Returns what happened in words.
   */
  importPlan: (raw: unknown, sourceLabel?: string) => { ok: true; migrated: boolean; repairs: string[] } | { ok: false; error: string };
  /**
   * Replaces the plan with one already normalized (a cloud pull, a recovery
   * copy). Keeps a copy of the current plan first when it holds content and
   * differs. Does not stamp a save, so a pull never echoes back as a push.
   */
  loadPlan: (plan: Plan, reason: string) => void;

  // Accounts
  addAccount: (account: Omit<Account, "id">) => void;
  updateAccount: (id: string, account: Omit<Account, "id">) => void;
  /** Returns false (without removing) if the account is still referenced by an
   * expense, income source, or event. */
  removeAccount: (id: string) => boolean;

  // Income
  addIncomeSource: (income: Omit<IncomeSource, "id">) => void;
  updateIncomeSource: (id: string, income: Omit<IncomeSource, "id">) => void;
  removeIncomeSource: (id: string) => void;

  // Expenses
  addExpense: (expense: Omit<ExpenseBaseline, "id">) => void;
  updateExpense: (id: string, expense: Omit<ExpenseBaseline, "id">) => void;
  removeExpense: (id: string) => void;

  // Events
  addEvent: (event: Omit<ScenarioEvent, "id">) => void;
  updateEvent: (id: string, event: Omit<ScenarioEvent, "id">) => void;
  removeEvent: (id: string) => void;
}

type Setter = (fn: (state: PlanState) => Partial<PlanState>) => void;

/**
 * Every mutation lands here. If the change removes something, the plan as it
 * stood is kept as a snapshot first (rule 4: never destroy a copy before its
 * replacement exists), and a delete also arms the Undo toast.
 */
function commit(set: Setter, updater: (plan: Plan) => Plan, opts?: { undoLabel?: string; snapshotReason?: string }) {
  set((state) => {
    const next = updater(state.plan);
    if (next === state.plan) return {};
    const shrank = isShrinkingChange(state.plan, next);
    if (shrank) keepPlanCopy(state.plan, "snapshot", opts?.snapshotReason ?? opts?.undoLabel ?? "Before a change that removed something");
    return {
      plan: next,
      lastSavedAt: Date.now(),
      pendingUndo: opts?.undoLabel ? { label: opts.undoLabel, plan: state.plan } : state.pendingUndo,
    };
  });
}

function withActiveScenario(set: Setter, updater: (scenario: Scenario) => Scenario, opts?: { undoLabel?: string }) {
  commit(
    set,
    (plan) => ({
      ...plan,
      scenarios: plan.scenarios.map((s) => (s.id === plan.activeScenarioId ? updater(s) : s)),
    }),
    opts
  );
}

export const usePlanStore = create<PlanState>()(
  persist(
    (set, get) => ({
      plan: defaultPlan,
      lastSavedAt: 0,
      hasHydrated: false,
      setHasHydrated: (value) => set(() => ({ hasHydrated: value })),
      loadIssue: null,
      clearLoadIssue: () => set(() => ({ loadIssue: null })),
      pendingUndo: null,
      undoLastDelete: () =>
        set((state) => (state.pendingUndo ? { plan: state.pendingUndo.plan, pendingUndo: null, lastSavedAt: Date.now() } : {})),
      clearPendingUndo: () => set(() => ({ pendingUndo: null })),

      activeScenario: () => {
        const { plan } = get();
        return plan.scenarios.find((s) => s.id === plan.activeScenarioId) ?? plan.scenarios[0];
      },

      setActiveScenarioId: (id) =>
        set((state) => ({
          plan: { ...state.plan, activeScenarioId: id },
          // Comparing a scenario with itself shows nothing useful: clear it.
          compareScenarioId: state.compareScenarioId === id ? null : state.compareScenarioId,
        })),

      compareScenarioId: null,
      setCompareScenarioId: (id) => set((state) => ({ compareScenarioId: id === state.plan.activeScenarioId ? null : id })),

      duplicateScenario: (sourceId, newName) => {
        const source = get().plan.scenarios.find((s) => s.id === sourceId);
        if (!source) return sourceId;
        const newId = nanoid();
        const copy: Scenario = { ...source, id: newId, name: newName, createdFromScenarioId: source.id };
        commit(set, (plan) => ({ ...plan, scenarios: [...plan.scenarios, copy], activeScenarioId: newId }));
        return newId;
      },

      addBlankScenario: (newName) => {
        const blank = makeBlankScenario(newName);
        commit(set, (plan) => ({ ...plan, scenarios: [...plan.scenarios, blank], activeScenarioId: blank.id }));
        return blank.id;
      },

      renameScenario: (id, name) =>
        commit(set, (plan) => ({ ...plan, scenarios: plan.scenarios.map((s) => (s.id === id ? { ...s, name } : s)) })),

      deleteScenario: (id) => {
        const target = get().plan.scenarios.find((s) => s.id === id);
        if (!target) return;
        set((state) => (state.compareScenarioId === id ? { compareScenarioId: null } : {}));
        commit(
          set,
          (plan) => {
            const remaining = plan.scenarios.filter((s) => s.id !== id);
            if (remaining.length === 0) return plan;
            const activeScenarioId = plan.activeScenarioId === id ? remaining[0].id : plan.activeScenarioId;
            return { ...plan, scenarios: remaining, activeScenarioId };
          },
          { undoLabel: `Deleted scenario "${target.name}"` }
        );
      },

      loadSamplePlan: () => {
        const sample: Scenario = normalizeScenario({ ...mockScenario, id: nanoid(), name: "Sample household" });
        commit(set, (plan) => {
          if (!planHasContent(plan)) return { ...plan, scenarios: [sample], activeScenarioId: sample.id };
          return { ...plan, scenarios: [...plan.scenarios, sample], activeScenarioId: sample.id };
        });
      },

      addPerson: (person) =>
        withActiveScenario(set, (s) => ({
          ...s,
          household: { people: [...s.household.people, { ...person, id: nanoid() }] },
        })),

      updatePerson: (id, person) =>
        withActiveScenario(set, (s) => ({
          ...s,
          household: { people: s.household.people.map((p) => (p.id === id ? { ...person, id } : p)) },
        })),

      removePerson: (id) => {
        const scenario = get().activeScenario();
        const person = scenario.household.people.find((p) => p.id === id);
        const referenced =
          scenario.accounts.some((a) => a.ownerId === id) ||
          scenario.incomeSources.some((i) => i.ownerId === id) ||
          scenario.events.some((e) => "personId" in e && e.personId === id);
        if (referenced) return false;
        withActiveScenario(set, (s) => ({ ...s, household: { people: s.household.people.filter((p) => p.id !== id) } }), {
          undoLabel: `Removed ${person?.name ?? "a person"}`,
        });
        return true;
      },

      updateSettings: (settings) => withActiveScenario(set, (s) => ({ ...s, settings })),

      importPlan: (raw, sourceLabel = "a backup file") => {
        const result = normalizePlan(raw);
        if (!result.ok) return { ok: false, error: result.error };
        const current = get().plan;
        if (planHasContent(current)) keepPlanCopy(current, "replaced", `Before restoring ${sourceLabel}`);
        set({ plan: result.plan, lastSavedAt: Date.now(), pendingUndo: null, loadIssue: null });
        return { ok: true, migrated: result.migrated, repairs: result.repairs };
      },

      loadPlan: (plan, reason) => {
        const current = get().plan;
        if (current !== plan && planHasContent(current) && JSON.stringify(current) !== JSON.stringify(plan)) {
          keepPlanCopy(current, "replaced", reason);
        }
        set({ plan, pendingUndo: null });
      },

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
        // Extra Savings is the one mandatory account: the engine assumes exactly
        // one always exists (see scenarioSchema's auto-inject transform).
        if (account?.isExtraSavings) return false;
        const referenced =
          scenario.expenses.some((e) => e.paymentAccountId === id) ||
          scenario.incomeSources.some((i) => i.depositAccountId === id) ||
          scenario.events.some((e) => {
            switch (e.type) {
              case "retire":
                return e.retirementExpense?.paymentAccountId === id;
              case "buy_home":
                // Deliberately NOT checking e.realEstateAccountId here -- that
                // account is owned by this same event (see removeBoughtHome in
                // src/lib/buyHome.ts, which removes the account, then the
                // event, in that order); guarding it would deadlock its own
                // cascade delete.
                return e.downPaymentFromAccountId === id;
              case "sell_home":
                return e.realEstateAccountId === id || e.proceedsAccountId === id;
              case "roth_conversion":
              case "rollover":
              case "custom_transfer":
                return e.fromAccountId === id || e.toAccountId === id;
              case "pay_off_loan":
                return e.fromAccountId === id || e.loanAccountId === id;
              default:
                return false;
            }
          });
        if (referenced) return false;
        withActiveScenario(
          set,
          (s) => ({
            ...s,
            accounts: s.accounts.filter((a) => a.id !== id),
            // A deleted account's role in the money-flow waterfall is routing
            // metadata, not a hard reference -- drop it from either list.
            settings: {
              ...s.settings,
              moneyFlow: {
                ...s.settings.moneyFlow,
                splitOrder: s.settings.moneyFlow.splitOrder.filter((stop) => stop.accountId !== id),
                drainOrder: s.settings.moneyFlow.drainOrder.filter((stop) => stop.accountId !== id),
              },
            },
          }),
          { undoLabel: `Deleted ${account?.name ?? "an account"}` }
        );
        return true;
      },

      addIncomeSource: (income) =>
        withActiveScenario(set, (s) => ({ ...s, incomeSources: [...s.incomeSources, { ...income, id: nanoid() }] })),

      updateIncomeSource: (id, income) =>
        withActiveScenario(set, (s) => ({
          ...s,
          incomeSources: s.incomeSources.map((i) => (i.id === id ? { ...income, id } : i)),
        })),

      removeIncomeSource: (id) => {
        const name = get().activeScenario().incomeSources.find((i) => i.id === id)?.name ?? "an income";
        withActiveScenario(set, (s) => ({ ...s, incomeSources: s.incomeSources.filter((i) => i.id !== id) }), {
          undoLabel: `Deleted ${name}`,
        });
      },

      addExpense: (expense) =>
        withActiveScenario(set, (s) => ({ ...s, expenses: [...s.expenses, { ...expense, id: nanoid() }] })),

      updateExpense: (id, expense) =>
        withActiveScenario(set, (s) => ({
          ...s,
          expenses: s.expenses.map((e) => (e.id === id ? { ...expense, id } : e)),
        })),

      removeExpense: (id) => {
        const name = get().activeScenario().expenses.find((e) => e.id === id)?.name ?? "an expense";
        withActiveScenario(set, (s) => ({ ...s, expenses: s.expenses.filter((e) => e.id !== id) }), {
          undoLabel: `Deleted ${name}`,
        });
      },

      addEvent: (event) =>
        withActiveScenario(set, (s) => ({ ...s, events: [...s.events, { ...event, id: nanoid() } as ScenarioEvent] })),

      updateEvent: (id, event) =>
        withActiveScenario(set, (s) => ({
          ...s,
          events: s.events.map((e) => (e.id === id ? ({ ...event, id } as ScenarioEvent) : e)),
        })),

      removeEvent: (id) => {
        const name = get().activeScenario().events.find((e) => e.id === id)?.name ?? "an event";
        withActiveScenario(set, (s) => ({ ...s, events: s.events.filter((e) => e.id !== id) }), {
          undoLabel: `Deleted ${name}`,
        });
      },
    }),
    {
      name: PLAN_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ plan: state.plan }),
      merge: (persisted, current) => {
        const raw = (persisted as { plan?: unknown } | undefined)?.plan;
        // A brand-new browser has nothing saved: start empty, quietly.
        if (raw === undefined) return current;
        const result = normalizePlan(raw);
        if (!result.ok) {
          // The bytes are kept verbatim before the fallback plan is written
          // back over them, so a newer build or a person can still read them.
          const copyKey = keepBrokenCopy(JSON.stringify(raw), `Saved plan could not be loaded: ${result.error}`);
          return { ...current, loadIssue: { kind: "broken", message: result.error, copyKey } };
        }
        return {
          ...current,
          plan: result.plan,
          loadIssue: result.repairs.length ? { kind: "repaired", repairs: result.repairs } : null,
        };
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

/** Re-exported for callers that only need the question, not the store. */
export { planHasContent };
export type { NormalizeOk };

if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
  // Dev-only console access for debugging, e.g. `__planStore.getState().addPerson(...)`.
  (window as unknown as { __planStore: typeof usePlanStore }).__planStore = usePlanStore;
}
