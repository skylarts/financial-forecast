import { describe, expect, it } from "vitest";
import type { Transaction, TransactionType } from "@/domain/portfolio";
import { buildLotLedger, holdingTerm } from "./lots";

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

describe("buildLotLedger", () => {
  it("opens a lot per purchase and folds fees into cost basis", () => {
    const { openLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, fees: 5 }),
    ]);

    expect(openLots).toHaveLength(1);
    expect(openLots[0].quantity).toBe(10);
    expect(openLots[0].costBasis).toBe(1005);
  });

  it("closes oldest lots first when the sale names no lot", () => {
    const { openLots, closedLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150 }),
      tx({ type: "sell", date: "2025-03-10", quantity: 15, price: 200 }),
    ]);

    expect(closedLots).toHaveLength(2);
    expect(closedLots[0].quantity).toBe(10);
    expect(closedLots[0].costBasis).toBe(1000);
    expect(closedLots[0].term).toBe("long");
    expect(closedLots[1].quantity).toBe(5);
    expect(closedLots[1].costBasis).toBe(750);
    expect(closedLots[1].term).toBe("short");
    expect(openLots).toHaveLength(1);
    expect(openLots[0].quantity).toBe(5);
  });

  it("honors a specific lot id over FIFO", () => {
    const { closedLots, openLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, lotId: "LOT-A" }),
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150, lotId: "LOT-B" }),
      tx({ type: "sell", date: "2025-03-10", quantity: 10, price: 200, lotId: "LOT-B" }),
    ]);

    expect(closedLots).toHaveLength(1);
    expect(closedLots[0].id).toBe("LOT-B");
    expect(closedLots[0].costBasis).toBe(1500);
    expect(closedLots[0].gain).toBe(500);
    expect(openLots[0].id).toBe("LOT-A");
  });

  it("warns and falls back to FIFO when the named lot is not open", () => {
    const { closedLots, warnings } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, lotId: "LOT-A" }),
      tx({ type: "sell", date: "2025-03-10", quantity: 5, price: 200, lotId: "LOT-GONE" }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(closedLots[0].id).toBe("LOT-A");
    expect(closedLots[0].costBasis).toBe(500);
  });

  it("splits shares without changing cost basis", () => {
    const { openLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "split", date: "2024-08-01", quantity: 4 }),
    ]);

    expect(openLots[0].quantity).toBe(40);
    expect(openLots[0].costBasis).toBe(1000);
  });

  it("applies a same-day buy before a same-day sell regardless of file order", () => {
    const { closedLots, warnings } = buildLotLedger([
      tx({ type: "sell", date: "2024-01-10", quantity: 10, price: 120 }),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
    ]);

    expect(warnings).toHaveLength(0);
    expect(closedLots[0].costBasis).toBe(1000);
    expect(closedLots[0].gain).toBe(200);
  });

  it("flags an oversell and books it at zero basis rather than dropping it", () => {
    const { closedLots, warnings } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 5, price: 100 }),
      tx({ type: "sell", date: "2025-03-10", quantity: 8, price: 200 }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("more shares than the ledger holds");
    const proceeds = closedLots.reduce((sum, lot) => sum + lot.proceeds, 0);
    expect(proceeds).toBeCloseTo(1600, 6);
    expect(closedLots[1].costBasis).toBe(0);
  });

  it("keeps a transfer out from realizing a phantom loss", () => {
    const { closedLots, openLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "transfer_out", date: "2024-05-10", quantity: 10 }),
    ]);

    expect(openLots).toHaveLength(0);
    expect(closedLots[0].taxable).toBe(false);
  });

  it("runs a transferred-in holding period from the original acquisition date", () => {
    const { closedLots } = buildLotLedger([
      tx({
        type: "transfer_in",
        date: "2025-01-10",
        quantity: 10,
        price: 100,
        amount: 1000,
        acquiredDate: "2020-02-01",
      }),
      tx({ type: "sell", date: "2025-06-10", quantity: 10, price: 200 }),
    ]);

    expect(closedLots[0].term).toBe("long");
  });

  it("keeps lots of different accounts and symbols separate", () => {
    const { openLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 50, symbol: "VXUS" }),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, accountId: "acct-2" }),
    ]);

    expect(openLots).toHaveLength(3);
  });
});

describe("holdingTerm", () => {
  it("treats exactly one year as short-term", () => {
    expect(holdingTerm("2024-01-10", "2025-01-10")).toBe("short");
  });

  it("treats one year and a day as long-term", () => {
    expect(holdingTerm("2024-01-10", "2025-01-11")).toBe("long");
  });
});
