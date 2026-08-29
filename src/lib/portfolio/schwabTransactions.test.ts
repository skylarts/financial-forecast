import { describe, expect, it } from "vitest";
import { __testing } from "./schwabTransactions";

const { mapTransaction } = __testing;

/** A Schwab trade, in the leg shape the real API returns. */
function trade(
  symbol: string,
  quantity: number,
  price: number,
  effect: "OPENING" | "CLOSING",
  net: number,
  fees: { feeType: string; cost: number }[] = [],
) {
  return {
    activityId: 9001,
    type: "TRADE",
    status: "VALID",
    tradeDate: "2026-08-20T14:30:00+0000",
    netAmount: net,
    transferItems: [
      // Every trade carries all four fee legs whether or not they cost
      // anything, which is why they are summed rather than counted.
      ...fees.map((f) => ({ instrument: { assetType: "CURRENCY" }, ...f, amount: Math.abs(f.cost) })),
      {
        instrument: { assetType: "EQUITY", symbol, description: `${symbol} INC` },
        amount: quantity,
        price,
        cost: -quantity * price,
        positionEffect: effect,
      },
    ],
  };
}

const map = (tx: Parameters<typeof mapTransaction>[0]) => mapTransaction(tx, "hash");

describe("trades", () => {
  it("reads a purchase from the quantity's sign and the position effect", () => {
    const { row } = map(trade("QXO", 100, 12.5, "OPENING", -1250));
    expect(row).toMatchObject({ type: "buy", symbol: "QXO", quantity: 100, price: 12.5, amount: 1250 });
  });

  it("reads a sale", () => {
    const { row } = map(trade("KLAR", -50, 30, "CLOSING", 1500));
    expect(row).toMatchObject({ type: "sell", symbol: "KLAR", quantity: 50, amount: 1500 });
  });

  it("keeps a short apart from a sale, and a cover apart from a purchase", () => {
    // Sign alone cannot tell these apart from the ordinary cases, and the
    // difference decides which lots the trade draws down.
    expect(map(trade("GME", -10, 25, "OPENING", 250)).row).toMatchObject({ type: "short_sell" });
    expect(map(trade("GME", 10, 20, "CLOSING", -200)).row).toMatchObject({ type: "buy_to_cover" });
  });

  it("sums every fee leg that charged something", () => {
    const { row } = map(
      trade("KLAR", -50, 30, "CLOSING", 1499.2, [
        { feeType: "COMMISSION", cost: 0 },
        { feeType: "SEC_FEE", cost: -0.55 },
        { feeType: "TAF_FEE", cost: -0.25 },
        { feeType: "OPT_REG_FEE", cost: 0 },
      ]),
    );
    expect(row?.fees).toBe(0.8);
  });

  it("drops a cancelled event rather than booking it", () => {
    const cancelled = { ...trade("QXO", 100, 12.5, "OPENING", -1250), status: "INVALID" };
    expect(map(cancelled).row).toBeNull();
  });
});

describe("journals", () => {
  const journal = (description: string, net: number) => ({
    activityId: 5,
    type: "JOURNAL",
    status: "VALID",
    tradeDate: "2026-08-20T14:30:00+0000",
    description,
    netAmount: net,
    transferItems: [{ instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, amount: net }],
  });

  it("ignores cash journalled between the two sides of one account", () => {
    // Both halves of the move are real rows in the API and neither is a
    // deposit -- the money is in the same account before and after. In a real
    // account these outnumber actual trades more than two to one, so booking
    // them would not be a rounding error.
    expect(map(journal("TRF FUNDS FRM TYPE 1", 5000)).row).toBeNull();
    expect(map(journal("TRF FUNDS TO TYPE 2", -5000)).row).toBeNull();
  });

  it("ignores the brokerage's own bank sweep in both directions", () => {
    expect(map(journal("BANK SWEEP FR BROKERAGE", 900)).row).toBeNull();
    expect(map(journal("BROKERAGE SWEEP TO BANK", -900)).row).toBeNull();
  });

  it("still books a journal that moved money between accounts", () => {
    expect(map(journal("JOURNAL FRM 80962703", 2500)).row).toMatchObject({
      type: "cash_deposit",
      amount: 2500,
    });
  });

  it("books a charge against a holding as a fee, not a withdrawal", () => {
    // An ADR fee arrives as a journal naming the company. Treating it as the
    // user withdrawing money would misstate both cash and what it cost to
    // hold the position.
    expect(map(journal("TAIWAN SEMICONDUCTOR M FSPONSORED ADR", -3.2)).row).toMatchObject({
      type: "fee",
      amount: 3.2,
    });
  });
});

describe("transfers and income", () => {
  it("books a delivered position as a transfer and says the basis is missing", () => {
    const { row } = map({
      activityId: 77,
      type: "RECEIVE_AND_DELIVER",
      status: "VALID",
      tradeDate: "2026-03-02T14:30:00+0000",
      description: "UBER TECHNOLOGIES INC",
      netAmount: 0,
      transferItems: [
        {
          instrument: { assetType: "EQUITY", symbol: "UBER" },
          amount: 40,
          price: 70,
          cost: 0,
          positionEffect: "OPENING",
        },
      ],
    });
    expect(row).toMatchObject({ type: "transfer_in", symbol: "UBER", quantity: 40 });
    // The warning matters more than the row: these are exactly the positions
    // most likely to be in the ledger already from the sending brokerage's
    // statement, and they will not hash the same.
    expect(row?.notes.join(" ")).toMatch(/already be in the ledger/i);
  });

  it("books a dividend with no symbol, because Schwab sends none", () => {
    const { row } = map({
      activityId: 12,
      type: "DIVIDEND_OR_INTEREST",
      status: "VALID",
      tradeDate: "2026-06-10T14:30:00+0000",
      description: "GE VERNOVA INC",
      netAmount: 18.4,
      transferItems: [{ instrument: { assetType: "CURRENCY" }, amount: 18.4 }],
    });
    expect(row).toMatchObject({ type: "dividend", symbol: null, amount: 18.4 });
  });

  it("tells interest apart from a dividend by the wording", () => {
    const { row } = map({
      activityId: 13,
      type: "DIVIDEND_OR_INTEREST",
      status: "VALID",
      tradeDate: "2026-06-30T14:30:00+0000",
      description: "SCHWAB1 INT 06/30",
      netAmount: 1.12,
      transferItems: [{ instrument: { assetType: "CURRENCY" }, amount: 1.12 }],
    });
    expect(row).toMatchObject({ type: "interest" });
  });
});
