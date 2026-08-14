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
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
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

  it("closes several named lots in the order the trade names them", () => {
    const { closedLots, openLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, lotId: "LOT-A" }),
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150, lotId: "LOT-B" }),
      tx({ type: "buy", date: "2024-09-10", quantity: 10, price: 175, lotId: "LOT-C" }),
      tx({ type: "sell", date: "2025-03-10", quantity: 15, price: 200, lotId: "LOT-C, LOT-A" }),
    ]);

    expect(closedLots.map((lot) => lot.id)).toEqual(["LOT-C", "LOT-A"]);
    expect(closedLots[0].quantity).toBe(10);
    expect(closedLots[1].quantity).toBe(5);
    // The untouched middle lot is left whole, and A keeps its remainder.
    expect(openLots.map((lot) => [lot.id, lot.quantity])).toEqual([
      ["LOT-A", 5],
      ["LOT-B", 10],
    ]);
  });

  it("warns when a named lot is oversold but still draws the rest from real lots", () => {
    const { closedLots, warnings } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, lotId: "LOT-A" }),
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150, lotId: "LOT-B" }),
      tx({ type: "sell", date: "2025-03-10", quantity: 14, price: 200, lotId: "LOT-B" }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('Lot "LOT-B" is oversold');
    expect(warnings[0].message).toContain("only 10 were open");
    // The 4 extra shares come out of the other real lot, not a zero-basis one.
    expect(closedLots.map((lot) => lot.id)).toEqual(["LOT-B", "LOT-A"]);
    expect(closedLots[1].costBasis).toBe(400);
  });

  it("flags two lots sharing one id, since a sale can't tell them apart", () => {
    const { warnings } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, lotId: "LOT-A" }),
      tx({ type: "buy", date: "2024-06-10", quantity: 10, price: 150, lotId: "LOT-A" }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("already in use");
  });

  it("does not flag the same lot id reused across different accounts", () => {
    // A sale can only ever draw on its own account's queue for that symbol and
    // side, so two accounts naming a lot "LOT-A" are never competing for the
    // same shares -- there is nothing for a sale in either one to confuse it
    // with.
    const { warnings, closedLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, lotId: "LOT-A", accountId: "acct-1" }),
      tx({ type: "buy", date: "2024-06-10", quantity: 5, price: 150, lotId: "LOT-A", accountId: "acct-2" }),
      tx({ type: "sell", date: "2025-03-10", quantity: 10, price: 200, lotId: "LOT-A", accountId: "acct-1" }),
      tx({ type: "sell", date: "2025-03-10", quantity: 5, price: 200, lotId: "LOT-A", accountId: "acct-2" }),
    ]);

    expect(warnings).toHaveLength(0);
    // Each sale drew its own account's lot, at that account's cost.
    expect(closedLots.find((l) => l.accountId === "acct-1")?.costBasis).toBe(1000);
    expect(closedLots.find((l) => l.accountId === "acct-2")?.costBasis).toBe(750);
  });

  it("does not report an oversell when the named lot covers the trade exactly", () => {
    const { warnings } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, lotId: "LOT-A" }),
      tx({ type: "sell", date: "2025-03-10", quantity: 10, price: 200, lotId: "LOT-A" }),
    ]);

    expect(warnings).toHaveLength(0);
  });

  it("splits shares without changing cost basis", () => {
    const { openLots } = buildLotLedger([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "split", date: "2024-08-01", quantity: 4 }),
    ]);

    expect(openLots[0].quantity).toBe(40);
    expect(openLots[0].costBasis).toBe(1000);
  });

  it("spinoff: parent keeps its shares, hands a fraction of basis to the new symbol", () => {
    // DHR -> VLTO, September 2023: 1 VLTO per 3 DHR, 88.34% of basis stays with DHR.
    const { openLots } = buildLotLedger([
      tx({ type: "buy", date: "2022-01-10", quantity: 30, price: 100, symbol: "DHR" }),
      tx({
        type: "spinoff",
        date: "2023-09-30",
        symbol: "DHR",
        spinoffSymbol: "VLTO",
        spinoffShareRatio: 1 / 3,
        spinoffBasisRetained: 0.8834,
      }),
    ]);

    const dhr = openLots.find((l) => l.symbol === "DHR")!;
    const vlto = openLots.find((l) => l.symbol === "VLTO")!;
    expect(dhr.quantity).toBe(30); // unchanged: a spinoff never touches the parent's share count
    expect(dhr.costBasis).toBeCloseTo(2650.2, 5); // 3000 * 0.8834
    expect(vlto.quantity).toBeCloseTo(10, 10); // 30 * 1/3
    expect(vlto.costBasis).toBeCloseTo(349.8, 5); // 3000 * 0.1166
    expect(vlto.acquiredDate).toBe("2022-01-10"); // holding period tacks from the original purchase
  });

  it("spinoff: pro-rates basis across every open lot of the parent, by lot", () => {
    const { openLots } = buildLotLedger([
      tx({ type: "buy", date: "2022-01-10", quantity: 10, price: 100, symbol: "DHR" }),
      tx({ type: "buy", date: "2022-06-10", quantity: 10, price: 200, symbol: "DHR" }),
      tx({
        type: "spinoff",
        date: "2023-09-30",
        symbol: "DHR",
        spinoffSymbol: "VLTO",
        spinoffShareRatio: 1 / 3,
        spinoffBasisRetained: 0.8834,
      }),
    ]);

    const vltoLots = openLots.filter((l) => l.symbol === "VLTO");
    expect(vltoLots).toHaveLength(2);
    expect(vltoLots.find((l) => l.acquiredDate === "2022-01-10")?.costBasis).toBeCloseTo(1000 * 0.1166, 5);
    expect(vltoLots.find((l) => l.acquiredDate === "2022-06-10")?.costBasis).toBeCloseTo(2000 * 0.1166, 5);
  });

  it("spinoff: a full exchange (basis retained 0) retires the parent and opens the new symbol at full basis", () => {
    // GGPI -> PSNY, June 2022: 1:1, a tax-free Section 351 exchange -- GGPI stops existing.
    const { openLots, closedLots } = buildLotLedger([
      tx({ type: "buy", date: "2021-10-01", quantity: 100, price: 10, symbol: "GGPI" }),
      tx({
        type: "spinoff",
        date: "2022-06-23",
        symbol: "GGPI",
        spinoffSymbol: "PSNY",
        spinoffShareRatio: 1,
        spinoffBasisRetained: 0,
      }),
    ]);

    expect(openLots.find((l) => l.symbol === "GGPI")).toBeUndefined();
    const psny = openLots.find((l) => l.symbol === "PSNY")!;
    expect(psny.quantity).toBe(100);
    expect(psny.costBasis).toBe(1000);
    expect(psny.acquiredDate).toBe("2021-10-01"); // full holding-period carryover

    expect(closedLots).toHaveLength(1);
    expect(closedLots[0].symbol).toBe("GGPI");
    expect(closedLots[0].taxable).toBe(false);
    expect(closedLots[0].untaxedReason).toBe("reorganization");
    expect(closedLots[0].gain).toBe(0);
  });

  it("spinoff: warns and does nothing when there's no open position to apply it to", () => {
    const { openLots, warnings } = buildLotLedger([
      tx({
        type: "spinoff",
        date: "2023-09-30",
        symbol: "DHR",
        spinoffSymbol: "VLTO",
        spinoffShareRatio: 1 / 3,
        spinoffBasisRetained: 0.8834,
      }),
    ]);

    expect(openLots).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/no open DHR position/);
  });

  it("spinoff: warns and does nothing when the ratio or basis fields are missing", () => {
    const { warnings } = buildLotLedger([
      tx({ type: "buy", date: "2022-01-10", quantity: 10, price: 100, symbol: "DHR" }),
      tx({ type: "spinoff", date: "2023-09-30", symbol: "DHR", spinoffSymbol: "VLTO" }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/needs a new symbol/);
  });

  it("spinoff: rounds the child quantity to the same 5 decimals every statement prints", () => {
    // A real case: 0.14762 DHR at 1/3 is 0.049206666... VLTO -- full precision
    // would drift a few millionths of a share away from the 0.04921 the
    // statement itself prints on the sale that later closes this lot, which
    // reads as a (harmless but noisy) oversell. Rounded, it matches exactly.
    const { openLots, closedLots, warnings } = buildLotLedger([
      tx({ type: "buy", date: "2022-01-10", quantity: 0.14762, price: 100, symbol: "DHR" }),
      tx({
        type: "spinoff",
        date: "2023-09-30",
        symbol: "DHR",
        spinoffSymbol: "VLTO",
        spinoffShareRatio: 1 / 3,
        spinoffBasisRetained: 0.8834,
      }),
      tx({ type: "sell", date: "2023-10-06", quantity: 0.04921, price: 50, symbol: "VLTO" }),
    ]);

    expect(openLots.find((l) => l.symbol === "VLTO")).toBeUndefined();
    expect(closedLots.find((l) => l.symbol === "VLTO")?.quantity).toBe(0.04921);
    expect(warnings).toHaveLength(0);
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

describe("short positions", () => {
  it("opens a short lot without touching long lots", () => {
    const { openLots } = buildLotLedger([
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
    ]);

    expect(openLots).toHaveLength(1);
    expect(openLots[0].side).toBe("short");
    expect(openLots[0].quantity).toBe(100);
    expect(openLots[0].costBasis).toBe(5000);
  });

  it("does not warn about an oversell when the shares were shorted", () => {
    const { warnings, openLots } = buildLotLedger([
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
    ]);

    expect(warnings).toHaveLength(0);
    expect(openLots[0].side).toBe("short");
  });

  it("profits when the cover costs less than the short brought in", () => {
    const { closedLots, openLots } = buildLotLedger([
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
      tx({ type: "buy_to_cover", date: "2025-06-01", quantity: 100, price: 30 }),
    ]);

    expect(openLots).toHaveLength(0);
    expect(closedLots[0].side).toBe("short");
    expect(closedLots[0].costBasis).toBe(5000);
    expect(closedLots[0].proceeds).toBe(3000);
    expect(closedLots[0].gain).toBe(2000);
  });

  it("loses when the cover costs more than the short brought in", () => {
    const { closedLots } = buildLotLedger([
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
      tx({ type: "buy_to_cover", date: "2025-06-01", quantity: 100, price: 65 }),
    ]);

    expect(closedLots[0].gain).toBe(-1500);
  });

  it("charges fees against the short in both directions", () => {
    const { closedLots } = buildLotLedger([
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50, fees: 10 }),
      tx({ type: "buy_to_cover", date: "2025-06-01", quantity: 100, price: 30, fees: 10 }),
    ]);

    expect(closedLots[0].costBasis).toBe(4990);
    expect(closedLots[0].proceeds).toBe(3010);
    expect(closedLots[0].gain).toBe(1980);
  });

  it("keeps a sell off short lots and a cover off long lots", () => {
    const { closedLots, warnings } = buildLotLedger([
      tx({ type: "buy", date: "2025-01-01", quantity: 10, price: 100 }),
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
      tx({ type: "sell", date: "2025-03-01", quantity: 10, price: 120 }),
    ]);

    // The sell must draw on the 10 owned shares, not the 100 shorted ones.
    expect(warnings).toHaveLength(0);
    expect(closedLots).toHaveLength(1);
    expect(closedLots[0].side).toBe("long");
    expect(closedLots[0].gain).toBe(200);
  });

  it("flags covering more shares than were ever shorted", () => {
    const { warnings } = buildLotLedger([
      tx({ type: "short_sell", date: "2025-02-01", quantity: 50, price: 50 }),
      tx({ type: "buy_to_cover", date: "2025-06-01", quantity: 80, price: 30 }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("more shares than the ledger shows shorted");
  });

  it("tells the user about the short option when a sale outruns the ledger", () => {
    const { warnings } = buildLotLedger([tx({ type: "sell", date: "2025-03-10", quantity: 8, price: 200 })]);

    expect(warnings[0].message).toContain("Sell short");
  });

  it("applies a split to short lots too", () => {
    const { openLots } = buildLotLedger([
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
      tx({ type: "split", date: "2025-03-01", quantity: 2 }),
    ]);

    expect(openLots[0].quantity).toBe(200);
    expect(openLots[0].costBasis).toBe(5000);
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
