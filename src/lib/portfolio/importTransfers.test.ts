import { describe, expect, it } from "vitest";
import type { Transaction } from "@/domain/portfolio";
import { findTransferPeer } from "./importTransfers";

function cash(id: string, accountId: string, date: string, type: "cash_deposit" | "cash_withdrawal", amount: number | null, quantity = 0, price = 0): Transaction {
  return {
    id,
    accountId,
    date,
    type,
    symbol: null,
    quantity,
    price,
    amount,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: "",
    importBatchId: null,
    sourceHash: null,
  };
}

const deposit = { date: "2026-01-16", type: "cash_deposit", amount: 6999.59, quantity: 0, price: 0 };

describe("findTransferPeer", () => {
  it("matches a withdrawal of the same dollars in another account on the same day", () => {
    const peer = cash("w1", "brokerage", "2026-01-16", "cash_withdrawal", 6999.59);
    expect(findTransferPeer(deposit, [peer])?.transaction.id).toBe("w1");
  });

  it("allows the few days an ACH takes, and prefers the nearest", () => {
    const near = cash("w-near", "brokerage", "2026-01-15", "cash_withdrawal", 6999.59);
    const far = cash("w-far", "brokerage", "2026-01-13", "cash_withdrawal", 6999.59);
    const result = findTransferPeer(deposit, [far, near]);
    expect(result?.transaction.id).toBe("w-near");
    expect(result?.daysApart).toBe(1);
  });

  it("does not reach past the window", () => {
    const old = cash("w-old", "brokerage", "2026-01-10", "cash_withdrawal", 6999.59);
    expect(findTransferPeer(deposit, [old])).toBeNull();
  });

  it("insists on the same direction reversed and the same cents", () => {
    const sameWay = cash("d", "brokerage", "2026-01-16", "cash_deposit", 6999.59);
    const offByACent = cash("w", "brokerage", "2026-01-16", "cash_withdrawal", 6999.58);
    expect(findTransferPeer(deposit, [sameWay, offByACent])).toBeNull();
  });

  it("reads a derived amount from shares times price", () => {
    const peer = cash("w1", "brokerage", "2026-01-16", "cash_withdrawal", null, 1, 6999.59);
    expect(findTransferPeer(deposit, [peer])?.transaction.id).toBe("w1");
  });

  it("has nothing to say about a trade", () => {
    expect(findTransferPeer({ ...deposit, type: "buy" }, [cash("w1", "b", "2026-01-16", "cash_withdrawal", 6999.59)])).toBeNull();
  });
});
