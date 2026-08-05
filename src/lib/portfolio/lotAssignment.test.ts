import { describe, expect, it } from "vitest";
import type { Transaction, TransactionType } from "@/domain/portfolio";
import { assignLotIds } from "./lotAssignment";

let seq = 0;
function tx(partial: Partial<Transaction> & { type: TransactionType; date: string }): Transaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    accountId: "acct-1",
    symbol: "VTI",
    quantity: 0,
    price: 0,
    amount: null,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    note: "",
    importBatchId: null,
    sourceHash: null,
    ...partial,
  };
}

const lotIds = (rows: Transaction[]) => rows.map((row) => row.lotId);

describe("assignLotIds", () => {
  it("names every purchase that arrived without a lot id", () => {
    const rows = assignLotIds([
      tx({ type: "buy", date: "2024-03-15", quantity: 10, price: 100 }),
      tx({ type: "buy", date: "2024-03-15", quantity: 5, price: 110 }),
      tx({ type: "buy", date: "2024-04-01", quantity: 5, price: 120, symbol: "VXUS" }),
    ]);

    expect(lotIds(rows)).toEqual(["VTI-20240315-1", "VTI-20240315-2", "VXUS-20240401-1"]);
  });

  it("matches a sale to the lot it drew on", () => {
    const rows = assignLotIds([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "sell", date: "2025-03-10", quantity: 4, price: 200 }),
    ]);

    expect(rows[1].lotId).toBe("VTI-20240110-1");
  });

  it("names every lot a sale spanning several of them closed", () => {
    const rows = assignLotIds([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150 }),
      tx({ type: "sell", date: "2025-03-10", quantity: 15, price: 200 }),
    ]);

    expect(rows[2].lotId).toBe("VTI-20240110-1, VTI-20240610-1");
  });

  it("never rewrites an id the statement or the user already set", () => {
    const rows = assignLotIds([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, lotId: "SCHWAB-77" }),
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150 }),
      tx({ type: "sell", date: "2025-03-10", quantity: 10, price: 200, lotId: "SCHWAB-77" }),
    ]);

    expect(lotIds(rows)).toEqual(["SCHWAB-77", "VTI-20240610-1", "SCHWAB-77"]);
  });

  it("steps around an id a sale already names, rather than silently adopting it", () => {
    // The user typed a lot onto a sale that nothing opens yet. Minting that
    // exact id onto the nearby purchase would invent a link they never made;
    // the ledger's own "lot isn't open" warning is the honest answer instead.
    const rows = assignLotIds([
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150 }),
      tx({ type: "sell", date: "2025-03-10", quantity: 10, price: 200, lotId: "VTI-20240610-1" }),
    ]);

    expect(rows[0].lotId).toBe("VTI-20240610-2");
  });

  it("mints around an id already in use rather than colliding with it", () => {
    const rows = assignLotIds([
      tx({ type: "buy", date: "2024-03-15", quantity: 10, price: 100, lotId: "VTI-20240315-1" }),
      tx({ type: "buy", date: "2024-03-15", quantity: 5, price: 110 }),
    ]);

    expect(rows[1].lotId).toBe("VTI-20240315-2");
  });

  it("is a no-op the second time, so it can run after every edit", () => {
    const first = assignLotIds([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150 }),
      tx({ type: "sell", date: "2025-03-10", quantity: 15, price: 200 }),
    ]);

    expect(assignLotIds(first)).toBe(first);
  });

  it("numbers lots by acquisition date, not the order rows were entered", () => {
    const rows = assignLotIds([
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150 }),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
    ]);

    expect(lotIds(rows)).toEqual(["VTI-20240610-1", "VTI-20240110-1"]);
  });

  it("dates a transferred-in lot from its original acquisition", () => {
    const rows = assignLotIds([
      tx({
        type: "transfer_in",
        date: "2025-01-10",
        quantity: 10,
        price: 100,
        amount: 1000,
        acquiredDate: "2020-02-01",
      }),
    ]);

    expect(rows[0].lotId).toBe("VTI-20200201-1");
  });

  it("leaves a sale unmatched rather than pointing it at a lot that never existed", () => {
    const rows = assignLotIds([tx({ type: "sell", date: "2025-03-10", quantity: 8, price: 200 })]);

    expect(rows[0].lotId).toBeNull();
  });

  it("matches a cover against the short it closed, not against long lots", () => {
    const rows = assignLotIds([
      tx({ type: "buy", date: "2025-01-01", quantity: 10, price: 100 }),
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
      tx({ type: "buy_to_cover", date: "2025-06-01", quantity: 100, price: 30 }),
    ]);

    expect(rows[2].lotId).toBe(rows[1].lotId);
    expect(rows[2].lotId).toBe("VTI-20250201-1");
  });

  it("keeps cash rows and zero-share rows out of lot accounting", () => {
    const rows = assignLotIds([
      tx({ type: "cash_deposit", date: "2024-01-02", symbol: null, amount: 5000 }),
      tx({ type: "dividend", date: "2024-02-02", amount: 25 }),
      tx({ type: "buy", date: "2024-03-01", quantity: 0, price: 100 }),
    ]);

    expect(lotIds(rows)).toEqual([null, null, null]);
  });
});
