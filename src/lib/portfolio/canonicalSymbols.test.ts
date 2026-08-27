import { describe, expect, it } from "vitest";
import type { Portfolio, Transaction } from "@/domain/portfolio";
import { withCanonicalSymbols } from "./canonicalSymbols";

function tx(patch: Partial<Transaction>): Transaction {
  return {
    id: patch.id ?? "t1",
    accountId: "a1",
    date: "2026-01-01",
    type: "buy",
    symbol: null,
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
    ...patch,
  };
}

function portfolio(patch: Partial<Portfolio>): Portfolio {
  return { id: "p1", accounts: [], transactions: [], securities: [], ...patch };
}

describe("withCanonicalSymbols", () => {
  it("rewrites a written contract to canonical OCC", () => {
    const result = withCanonicalSymbols(
      portfolio({ transactions: [tx({ symbol: "KLAR 01/21/2028 17.50 C" })] }),
    );
    expect(result.transactions[0].symbol).toBe("KLAR280121C00017500");
  });

  it("leaves an already-canonical ledger untouched (same reference)", () => {
    const input = portfolio({ transactions: [tx({ symbol: "VTI" })] });
    expect(withCanonicalSymbols(input)).toBe(input);
  });

  it("merges two security records for the same contract spelled differently", () => {
    const result = withCanonicalSymbols(
      portfolio({
        securities: [
          {
            symbol: "KLAR260508C15",
            name: "first",
            assetClass: "other",
            assetClassSource: "manual",
            exposures: [],
            instrumentType: "other",
            instrumentTypeSource: "manual",
            themes: [],
            manualPrice: null,
            manualPriceDate: null,
            lastKnownPrice: null,
            lastKnownPriceDate: null,
          },
          {
            symbol: "KLAR 05/08/2026 15 C",
            name: "second",
            assetClass: "other",
            assetClassSource: "manual",
            exposures: [],
            instrumentType: "other",
            instrumentTypeSource: "manual",
            themes: [],
            manualPrice: null,
            manualPriceDate: null,
            lastKnownPrice: null,
            lastKnownPriceDate: null,
          },
        ],
      }),
    );
    expect(result.securities).toHaveLength(1);
    expect(result.securities[0].symbol).toBe("KLAR260508C00015000");
    // First one wins, so an existing manual name/class survives the merge.
    expect(result.securities[0].name).toBe("first");
  });
});
