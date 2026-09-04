import { describe, expect, it } from "vitest";
import type { Portfolio, Transaction, TransactionType } from "@/domain/portfolio";
import { toCsv, toBackupJson } from "./exportLedger";
import { buildImportRows, guessMapping, parseDelimited } from "./importer";

let seq = 0;
function tx(partial: Partial<Transaction> & { type: TransactionType; date: string }): Transaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    accountId: "acct-1",
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
    ...partial,
  };
}

function portfolio(transactions: Transaction[]): Portfolio {
  return {
    id: "p1",
    accounts: [
      {
        id: "acct-1",
        name: "Brokerage",
        institution: "Fidelity",
        type: "taxable",
        forecastAccountId: null,
        syncToForecast: true,
        ownerId: null,
        openingCashBalance: 0,
        parentAccountId: null,
        schwabAccountHash: null,
      },
    ],
    transactions,
    securities: [],
    baskets: [],
  };
}

describe("toCsv", () => {
  it("orders oldest first, whatever order the ledger holds", () => {
    const csv = toCsv(
      portfolio([
        tx({ type: "sell", date: "2026-02-05", symbol: "VTI", quantity: -5, price: 300 }),
        tx({ type: "buy", date: "2025-01-06", symbol: "VTI", quantity: 15, price: 280 }),
      ]),
    );
    const dates = csv.split("\n").slice(1).map((l) => l.split(",")[0]);
    expect(dates).toEqual(["2025-01-06", "2026-02-05"]);
  });

  it("quotes a field containing a comma rather than splitting the row", () => {
    const csv = toCsv(
      portfolio([tx({ type: "cash_deposit", date: "2025-01-02", amount: 5000, note: "Opening, seed" })]),
    );
    expect(csv).toContain('"Opening, seed"');
    // One header row and one data row: the comma did not manufacture a third.
    expect(csv.split("\n")).toHaveLength(2);
  });

  it("leaves a null amount empty instead of writing a zero", () => {
    // The ledger reads a blank amount as "derive it from quantity x price". A
    // literal 0 would import as a trade that moved no money at all.
    const csv = toCsv(
      portfolio([tx({ type: "buy", date: "2025-01-06", symbol: "VTI", quantity: 15, price: 280 })]),
    );
    const amount = csv.split("\n")[1].split(",")[5];
    expect(amount).toBe("");
  });
});

describe("round trip", () => {
  it("re-imports its own export without a mapping step", () => {
    const rows = [
      tx({ type: "cash_deposit", date: "2025-01-02", amount: 5000, note: "Opening, seed" }),
      tx({ type: "buy", date: "2025-01-06", symbol: "VTI", quantity: 15, price: 280, fees: 1.25, lotId: "L1" }),
      tx({ type: "dividend", date: "2025-06-20", symbol: "VTI", amount: 42.15 }),
      // Quantity is always positive in the ledger; direction lives in the type.
      tx({ type: "sell", date: "2026-02-05", symbol: "VTI", quantity: 5, price: 300, lotId: "L1" }),
      tx({ type: "cash_withdrawal", date: "2026-03-01", amount: 100 }),
    ];
    const csv = toCsv(portfolio(rows));

    const table = parseDelimited(csv);
    const mapping = guessMapping(table.headers);
    // Every column the export writes has to be recognised on the way back in;
    // an unmapped one would silently drop that field.
    expect(mapping.date).not.toBeNull();
    expect(mapping.type).not.toBeNull();
    expect(mapping.symbol).not.toBeNull();
    expect(mapping.quantity).not.toBeNull();
    expect(mapping.price).not.toBeNull();
    expect(mapping.amount).not.toBeNull();

    const imported = buildImportRows(table, mapping);
    expect(imported).toHaveLength(rows.length);
    expect(imported.map((r) => r.draft.type)).toEqual([
      "cash_deposit",
      "buy",
      "dividend",
      "sell",
      "cash_withdrawal",
    ]);
    expect(imported.map((r) => r.draft.date)).toEqual([
      "2025-01-02",
      "2025-01-06",
      "2025-06-20",
      "2026-02-05",
      "2026-03-01",
    ]);
    // The buy keeps its shares, its fee and the lot it opened.
    const buy = imported[1].draft;
    expect(buy.quantity).toBeCloseTo(15, 6);
    expect(buy.price).toBeCloseTo(280, 6);
    expect(buy.fees).toBeCloseTo(1.25, 6);
    expect(buy.lotId).toBe("L1");
    // The sale comes back as a sale of five shares -- the type carries the
    // direction, so a re-import must not flip it into a purchase.
    expect(imported[3].draft.quantity).toBeCloseTo(5, 6);
    expect(imported[3].draft.type).toBe("sell");
  });
});

describe("toBackupJson", () => {
  it("writes the whole portfolio, parseable back", () => {
    const p = portfolio([tx({ type: "buy", date: "2025-01-06", symbol: "VTI", quantity: 1, price: 10 })]);
    const parsed = JSON.parse(toBackupJson(p));
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.accounts[0].openingCashBalance).toBe(0);
  });
});
