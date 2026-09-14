import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "@/store/usePlanStore";
import { openNewLoan, updateOpenedLoan, removeOpenedLoan } from "./openLoan";
import { payOffLoanEventSchema } from "@/domain";
import type { KeyValueStorage } from "@/lib/planRecovery";

/** The store persists to localStorage; Node has none. Same shim the store's
 *  own tests install. */
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
installStorage();

const SETTINGS = { startDate: "2026-01-01", inflationRatePct: 0 };
const INPUT = {
  name: "Car loan",
  startDate: "2030-01-01",
  principal: "40,000",
  annualInterestRatePct: "6",
  termYears: "5",
  extraPrincipalMonthly: "",
  proceedsAccountId: "",
  kind: "fixed" as const,
  drawYears: "",
  securedByAccountId: "",
};

function scenario() {
  return usePlanStore.getState().activeScenario();
}
function theLoan() {
  return scenario().accounts.find((a) => a.class === "loan" && a.name === "Car loan");
}
function theEvent() {
  return scenario().events.find((e) => e.type === "open_loan");
}

describe("openNewLoan", () => {
  beforeEach(() => {
    usePlanStore.setState({ pendingUndo: null, loadIssue: null, compareScenarioId: null });
    usePlanStore.getState().loadSamplePlan();
    usePlanStore.setState({ pendingUndo: null });
  });

  it("creates the loan account and the event that owns it, linked to each other", () => {
    expect(openNewLoan(INPUT, SETTINGS)).toEqual({ ok: true });
    const loan = theLoan();
    const event = theEvent();
    expect(loan).toBeDefined();
    expect(event).toBeDefined();
    expect(event!.type === "open_loan" && event!.loanAccountId).toBe(loan!.id);
    // The account starts the day the loan does, which is what keeps the debt
    // off the books until then.
    expect(loan!.startDate).toBe("2030-01-01");
    expect(loan!.loanTerms?.originationDate).toBe("2030-01-01");
    expect(loan!.loanTerms?.termMonths).toBe(60);
    expect(loan!.startingBalance).toBeCloseTo(40_000, 0);
  });

  it("rejects a loan with no date, amount, or term rather than writing a broken one", () => {
    expect(openNewLoan({ ...INPUT, startDate: "" }, SETTINGS).ok).toBe(false);
    expect(openNewLoan({ ...INPUT, principal: "" }, SETTINGS).ok).toBe(false);
    // A blank term is what silently produced a one-month balloon loan.
    expect(openNewLoan({ ...INPUT, termYears: "" }, SETTINGS).ok).toBe(false);
    expect(scenario().events.filter((e) => e.type === "open_loan")).toHaveLength(0);
  });

  it("edits the event and its account together, so the two can't disagree", () => {
    openNewLoan(INPUT, SETTINGS);
    const id = theEvent()!.id;
    expect(updateOpenedLoan(id, { ...INPUT, principal: "25,000", termYears: "3", startDate: "2031-06-01" }, SETTINGS)).toEqual({ ok: true });

    const loan = theLoan()!;
    const event = theEvent()!;
    expect(loan.startingBalance).toBeCloseTo(25_000, 0);
    expect(loan.startDate).toBe("2031-06-01");
    expect(loan.loanTerms?.originationDate).toBe("2031-06-01");
    expect(loan.loanTerms?.termMonths).toBe(36);
    expect(event.type === "open_loan" && event.principal).toBe(25_000);
    expect(event.startDate).toBe("2031-06-01");
    // Still exactly one loan account -- editing must never leave an orphan
    // behind the way a duplicated mortgage once did.
    expect(scenario().accounts.filter((a) => a.class === "loan" && a.name === "Car loan")).toHaveLength(1);
  });

  it("deleting the event takes its loan account with it", () => {
    openNewLoan(INPUT, SETTINGS);
    const loanId = theLoan()!.id;
    expect(removeOpenedLoan(theEvent()!.id)).toEqual({ ok: true });
    expect(scenario().accounts.some((a) => a.id === loanId)).toBe(false);
    expect(scenario().events.some((e) => e.type === "open_loan")).toBe(false);
  });

  it("refuses to delete while a Pay off a loan event still points at the loan", () => {
    openNewLoan(INPUT, SETTINGS);
    const loanId = theLoan()!.id;
    const payer = scenario().accounts.find((a) => a.class === "cash")!;
    // Parsed through its own schema first, the way every real call site builds
    // an event -- addEvent's parameter is a collapsed union otherwise.
    usePlanStore.getState().addEvent(
      payOffLoanEventSchema.omit({ id: true }).parse({
        type: "pay_off_loan",
        name: "Clear the car loan",
        startDate: "2032-01-01",
        loanAccountId: loanId,
        fromAccountId: payer.id,
        amount: null,
      })
    );

    const result = removeOpenedLoan(theEvent()!.id);
    expect(result.ok).toBe(false);
    // Nothing removed: the loan and its event both survive the refusal.
    expect(scenario().accounts.some((a) => a.id === loanId)).toBe(true);
    expect(theEvent()).toBeDefined();
  });

  it("keeps the proceeds account when the money lands somewhere", () => {
    const checking = usePlanStore.getState().activeScenario().accounts.find((a) => a.class === "cash")!;
    openNewLoan({ ...INPUT, proceedsAccountId: checking.id }, SETTINGS);
    const event = theEvent()!;
    expect(event.type === "open_loan" && event.proceedsAccountId).toBe(checking.id);
  });
});

describe("openNewLoan as a HELOC", () => {
  beforeEach(() => {
    usePlanStore.setState({ pendingUndo: null, loadIssue: null, compareScenarioId: null });
    usePlanStore.getState().loadSamplePlan();
    usePlanStore.setState({ pendingUndo: null });
  });

  it("writes the draw period and the home it is secured by onto the loan account", () => {
    const home = scenario().accounts.find((a) => a.class === "real_estate");
    // The sample plan buys its home later; a HELOC needs one to exist, so add one.
    const homeId =
      home?.id ??
      (() => {
        usePlanStore.getState().addAccount({
          name: "Home",
          class: "real_estate",
          category: "asset",
          ownerId: null,
          startingBalance: 400_000,
          growthRatePct: 0.03,
          taxTreatment: "n/a",
          subjectToRMD: false,
        });
        const accts = scenario().accounts;
        return accts[accts.length - 1].id;
      })();
    const result = openNewLoan(
      { ...INPUT, name: "HELOC", kind: "heloc", drawYears: "10", termYears: "20", securedByAccountId: homeId, principal: "60,000" },
      SETTINGS
    );
    expect(result).toEqual({ ok: true });
    const line = scenario().accounts.find((a) => a.class === "loan" && a.name === "HELOC")!;
    expect(line.loanTerms?.interestOnlyMonths).toBe(120);
    expect(line.loanTerms?.termMonths).toBe(240);
    expect(line.loanTerms?.linkedAssetId).toBe(homeId);
    const ev = scenario().events.find((e) => e.type === "open_loan")!;
    expect(ev.type === "open_loan" && ev.loanKind).toBe("heloc");
  });

  it("refuses a HELOC with no home or no draw period", () => {
    expect(openNewLoan({ ...INPUT, kind: "heloc", drawYears: "10", securedByAccountId: "" }, SETTINGS).ok).toBe(false);
    expect(openNewLoan({ ...INPUT, kind: "heloc", drawYears: "", securedByAccountId: "x" }, SETTINGS).ok).toBe(false);
  });
});
