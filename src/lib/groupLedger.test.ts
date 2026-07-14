import { describe, expect, it } from "vitest";
import { groupLedgerByYear } from "./groupLedger";
import type { LedgerEvent } from "@/domain";

function entry(overrides: Partial<LedgerEvent>): LedgerEvent {
  return {
    date: "2030-01-15",
    kind: "rmd",
    accountId: "acct-1",
    amount: 100,
    note: "",
    ...overrides,
  };
}

describe("groupLedgerByYear", () => {
  it("sums monthly entries into one row per year/kind/account", () => {
    const ledger: LedgerEvent[] = [
      entry({ date: "2030-01-15", amount: 100 }),
      entry({ date: "2030-02-15", amount: 100 }),
      entry({ date: "2030-03-15", amount: 100 }),
    ];
    const groups = groupLedgerByYear(ledger);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ year: 2030, kind: "rmd", accountId: "acct-1", totalAmount: 300 });
    expect(groups[0].entries).toHaveLength(3);
  });

  it("keeps different years, kinds, and accounts separate", () => {
    const ledger: LedgerEvent[] = [
      entry({ date: "2030-01-15", kind: "rmd", accountId: "acct-1" }),
      entry({ date: "2031-01-15", kind: "rmd", accountId: "acct-1" }),
      entry({ date: "2030-01-15", kind: "deficit_withdrawal", accountId: "acct-1" }),
      entry({ date: "2030-01-15", kind: "rmd", accountId: "acct-2" }),
    ];
    expect(groupLedgerByYear(ledger)).toHaveLength(4);
  });

  it("treats different toAccountId as distinct groups", () => {
    const ledger: LedgerEvent[] = [
      entry({ kind: "mortgage_payment", toAccountId: "acct-2" }),
      entry({ kind: "mortgage_payment", toAccountId: "acct-3" }),
    ];
    expect(groupLedgerByYear(ledger)).toHaveLength(2);
  });

  it("sorts groups by year, then kind, then account", () => {
    const ledger: LedgerEvent[] = [
      entry({ date: "2031-01-15", kind: "rmd", accountId: "b" }),
      entry({ date: "2030-01-15", kind: "deficit_withdrawal", accountId: "a" }),
      entry({ date: "2030-01-15", kind: "rmd", accountId: "a" }),
    ];
    const groups = groupLedgerByYear(ledger);
    expect(groups.map((g) => g.key)).toEqual([
      "2030|deficit_withdrawal|a|",
      "2030|rmd|a|",
      "2031|rmd|b|",
    ]);
  });

  it("returns an empty array for an empty ledger", () => {
    expect(groupLedgerByYear([])).toEqual([]);
  });
});
