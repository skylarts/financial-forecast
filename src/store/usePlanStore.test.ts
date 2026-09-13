import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore, planHasContent } from "./usePlanStore";
import { listRecoveryCopies, RECOVERY_PREFIX, type KeyValueStorage } from "@/lib/planRecovery";
import type { ScenarioEvent } from "@/domain";

/**
 * The store persists to `localStorage` and keeps recovery copies there too.
 * Node has none, so a minimal in-memory one is installed for these tests.
 */
function installStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  return storage;
}

const storage = installStorage();

function reset() {
  for (const key of [...Array(storage.length)].map((_, i) => storage.key(i)!)) storage.removeItem(key);
  usePlanStore.setState({ pendingUndo: null, loadIssue: null, compareScenarioId: null });
  usePlanStore.getState().loadSamplePlan();
  usePlanStore.setState({ pendingUndo: null });
  for (const key of [...Array(storage.length)].map((_, i) => storage.key(i)!)) {
    if (key.startsWith(RECOVERY_PREFIX)) storage.removeItem(key);
  }
}

describe("usePlanStore", () => {
  beforeEach(reset);

  it("starts empty, and the sample plan replaces the empty scenario rather than sitting beside it", () => {
    const s = usePlanStore.getState();
    expect(s.plan.scenarios).toHaveLength(1);
    expect(s.plan.scenarios[0].name).toBe("Sample household");
    expect(planHasContent(s.plan)).toBe(true);
    // Loading it again, now that content exists, appends instead.
    s.loadSamplePlan();
    expect(usePlanStore.getState().plan.scenarios).toHaveLength(2);
  });

  it("keeps a snapshot before a delete and arms undo", () => {
    const s = usePlanStore.getState();
    const expense = s.activeScenario().expenses[0];
    s.removeExpense(expense.id);
    expect(usePlanStore.getState().activeScenario().expenses.some((e) => e.id === expense.id)).toBe(false);
    expect(usePlanStore.getState().pendingUndo?.label).toBe(`Deleted ${expense.name}`);
    expect(listRecoveryCopies(storage).map((c) => c.kind)).toEqual(["snapshot"]);
    usePlanStore.getState().undoLastDelete();
    expect(usePlanStore.getState().activeScenario().expenses.some((e) => e.id === expense.id)).toBe(true);
    expect(usePlanStore.getState().pendingUndo).toBeNull();
  });

  it("does not snapshot an edit that removes nothing", () => {
    const s = usePlanStore.getState();
    s.renameScenario(s.plan.activeScenarioId, "Renamed");
    expect(listRecoveryCopies(storage)).toEqual([]);
    expect(usePlanStore.getState().pendingUndo).toBeNull();
  });

  it("refuses to delete an account that pays a retire event's retirement expense", () => {
    const s = usePlanStore.getState();
    const scenario = s.activeScenario();
    const brokerage = scenario.accounts.find((a) => a.name === "Joint Brokerage")!;
    const retire = scenario.events.find((e) => e.type === "retire")!;
    if (retire.type !== "retire") throw new Error("expected retire");
    s.updateEvent(retire.id, {
      ...retire,
      retirementExpense: { amount: 5000, growthRatePct: null, paymentAccountId: brokerage.id, endDate: null },
    } as unknown as Omit<ScenarioEvent, "id">);
    // Also referenced by the buy_home down payment and the inheritance; strip those first.
    const buy = usePlanStore.getState().activeScenario().events.find((e) => e.type === "buy_home")!;
    usePlanStore.getState().removeEvent(buy.id);
    const inheritance = usePlanStore.getState().activeScenario().incomeSources.find((i) => i.name === "Inheritance")!;
    usePlanStore.getState().updateIncomeSource(inheritance.id, { ...inheritance, depositAccountId: null });
    expect(usePlanStore.getState().removeAccount(brokerage.id)).toBe(false);
  });

  it("clears a comparison that would point at the active scenario", () => {
    const s = usePlanStore.getState();
    const otherId = s.duplicateScenario(s.plan.activeScenarioId, "Copy");
    const baseId = usePlanStore.getState().plan.scenarios[0].id;
    usePlanStore.getState().setActiveScenarioId(baseId);
    usePlanStore.getState().setCompareScenarioId(otherId);
    expect(usePlanStore.getState().compareScenarioId).toBe(otherId);
    usePlanStore.getState().setActiveScenarioId(otherId);
    expect(usePlanStore.getState().compareScenarioId).toBeNull();
    usePlanStore.getState().setCompareScenarioId(otherId);
    expect(usePlanStore.getState().compareScenarioId).toBeNull();
  });

  it("keeps a copy of the current plan before a file restore, and reports repairs", () => {
    const s = usePlanStore.getState();
    const raw = JSON.parse(JSON.stringify(s.plan));
    raw.scenarios[0].expenses[0].paymentAccountId = "no-such-account";
    const result = s.importPlan(raw, "test file");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toHaveLength(1);
    expect(listRecoveryCopies(storage).map((c) => c.kind)).toEqual(["replaced"]);
    expect(usePlanStore.getState().activeScenario().expenses[0].paymentAccountId).toBeNull();
  });

  it("rejects an invalid file without touching the plan", () => {
    const s = usePlanStore.getState();
    const before = s.plan;
    const result = s.importPlan({ id: "x", scenarios: [], activeScenarioId: "x" });
    expect(result.ok).toBe(false);
    expect(usePlanStore.getState().plan).toBe(before);
    expect(listRecoveryCopies(storage)).toEqual([]);
  });

  it("loadPlan keeps a copy of a differing local plan and does not stamp a save", () => {
    const s = usePlanStore.getState();
    const savedAt = s.lastSavedAt;
    const incoming = JSON.parse(JSON.stringify(s.plan));
    incoming.scenarios[0].name = "From the cloud";
    s.loadPlan(incoming, "Replaced by the cloud copy");
    expect(usePlanStore.getState().plan.scenarios[0].name).toBe("From the cloud");
    expect(usePlanStore.getState().lastSavedAt).toBe(savedAt);
    expect(listRecoveryCopies(storage).map((c) => c.reason)).toEqual(["Replaced by the cloud copy"]);
  });
});
