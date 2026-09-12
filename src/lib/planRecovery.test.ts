import { describe, expect, it } from "vitest";
import {
  contentCounts,
  deleteRecoveryCopy,
  isShrinkingChange,
  keepBrokenCopy,
  keepPlanCopy,
  listRecoveryCopies,
  readRecoveryCopy,
  RECOVERY_LIMIT,
  type KeyValueStorage,
} from "./planRecovery";
import { normalizePlan } from "./planIO";
import { mockScenario } from "./mockScenario";
import type { Plan } from "@/domain";

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function plan(): Plan {
  const r = normalizePlan({ id: "p", scenarios: [mockScenario], activeScenarioId: mockScenario.id });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}

describe("recovery copies", () => {
  it("keeps a plan copy and reads it back, newest first", () => {
    const storage = memoryStorage();
    const p = plan();
    keepPlanCopy(p, "snapshot", "Before deleting X", storage, 1000);
    keepPlanCopy(p, "replaced", "Cloud replaced it", storage, 2000);
    const list = listRecoveryCopies(storage);
    expect(list.map((c) => c.kind)).toEqual(["replaced", "snapshot"]);
    expect(list[0].scenarioCount).toBe(1);
    expect(readRecoveryCopy(list[1].key, storage)?.plan?.scenarios[0].name).toBe("Base Plan");
  });

  it("keeps the raw text of a broken plan verbatim", () => {
    const storage = memoryStorage();
    const key = keepBrokenCopy('{"not":"a plan"', "could not parse", storage, 5);
    expect(key).not.toBeNull();
    expect(readRecoveryCopy(key!, storage)?.raw).toBe('{"not":"a plan"');
    expect(listRecoveryCopies(storage)[0].scenarioCount).toBeNull();
  });

  it("prunes the oldest copies of a kind past the limit", () => {
    const storage = memoryStorage();
    const p = plan();
    for (let i = 0; i < RECOVERY_LIMIT + 3; i++) keepPlanCopy(p, "snapshot", `copy ${i}`, storage, 1000 + i);
    const list = listRecoveryCopies(storage);
    expect(list).toHaveLength(RECOVERY_LIMIT);
    expect(list[0].reason).toBe(`copy ${RECOVERY_LIMIT + 2}`);
  });

  it("deletes a copy and survives a missing storage", () => {
    const storage = memoryStorage();
    const key = keepPlanCopy(plan(), "snapshot", "x", storage, 1)!;
    deleteRecoveryCopy(key, storage);
    expect(listRecoveryCopies(storage)).toEqual([]);
    expect(keepPlanCopy(plan(), "snapshot", "x", null)).toBeNull();
    expect(listRecoveryCopies(null)).toEqual([]);
  });

  it("never throws when storage is full", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(keepPlanCopy(plan(), "snapshot", "x", storage)).toBeNull();
  });
});

describe("isShrinkingChange", () => {
  it("is true only when some count fell", () => {
    const before = plan();
    const s = before.scenarios[0];
    const fewerExpenses: Plan = { ...before, scenarios: [{ ...s, expenses: s.expenses.slice(1) }] };
    const moreExpenses: Plan = { ...before, scenarios: [{ ...s, expenses: [...s.expenses, s.expenses[0]] }] };
    const renamed: Plan = { ...before, scenarios: [{ ...s, name: "Other" }] };
    expect(isShrinkingChange(before, fewerExpenses)).toBe(true);
    expect(isShrinkingChange(before, moreExpenses)).toBe(false);
    expect(isShrinkingChange(before, renamed)).toBe(false);
    expect(isShrinkingChange(before, { ...before, scenarios: [] })).toBe(true);
    expect(contentCounts(before)[0]).toBe(1);
  });
});
