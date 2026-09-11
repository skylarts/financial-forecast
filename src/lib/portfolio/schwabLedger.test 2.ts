import { describe, expect, it } from "vitest";
import { buildImportRows, guessMapping, parseDelimited } from "./importer";
import { resolveSymbolByName, schwabRowsToCsv } from "./schwabLedger";
import type { SchwabLedgerRow } from "./schwabTransactions";

const row = (over: Partial<SchwabLedgerRow>): SchwabLedgerRow => ({
  activityId: "1",
  accountHash: "h",
  date: "2026-08-20",
  type: "buy",
  symbol: "QXO",
  quantity: 100,
  price: 12.5,
  amount: 1250,
  fees: 0,
  description: "",
  notes: [],
  ...over,
});

const securities = [
  { symbol: "GEV", name: "GE Vernova Inc." },
  { symbol: "TSM", name: "Taiwan Semiconductor Manufacturing Company Ltd." },
  { symbol: "GOOG", name: "Alphabet Inc." },
  { symbol: "META", name: "Meta Platforms, Inc." },
];

describe("resolveSymbolByName", () => {
  it("matches through the padding a brokerage adds to a company name", () => {
    // Schwab writes these exactly this way; the ledger's own names come from
    // the price feed and are spelled quite differently.
    expect(resolveSymbolByName("GE VERNOVA INC", securities)).toBe("GEV");
    expect(resolveSymbolByName("ALPHABET INC CLASS CLASS C", securities)).toBe("GOOG");
    expect(resolveSymbolByName("META PLATFORMS INC CLASS A", securities)).toBe("META");
    expect(
      resolveSymbolByName("TAIWAN SEMICONDUCTOR M FSPONSORED ADR 1 ADR REPS 5 ORD SHS", securities),
    ).toBe("TSM");
  });

  it("declines rather than guessing when nothing really matches", () => {
    // A wrong symbol here attaches income to a holding that never paid it,
    // which is worse than a blank the review step will flag.
    expect(resolveSymbolByName("SOME UNRELATED HOLDING CO", securities)).toBeNull();
    expect(resolveSymbolByName("", securities)).toBeNull();
  });
});

describe("schwabRowsToCsv", () => {
  it("emits headers the importer's own guesser already understands", () => {
    const table = parseDelimited(schwabRowsToCsv([row({})]));
    const mapping = guessMapping(table.headers);
    expect(mapping.date).not.toBeNull();
    expect(mapping.type).not.toBeNull();
    expect(mapping.symbol).not.toBeNull();
    expect(mapping.quantity).not.toBeNull();
    expect(mapping.price).not.toBeNull();
    expect(mapping.fees).not.toBeNull();
    expect(mapping.amount).not.toBeNull();
  });

  it("round-trips through the import pipeline into a usable draft", () => {
    const csv = schwabRowsToCsv([row({ type: "sell", symbol: "KLAR", quantity: 50, price: 30, amount: 1500, fees: 0.8 })]);
    const table = parseDelimited(csv);
    const rows = buildImportRows(table, guessMapping(table.headers));

    expect(rows).toHaveLength(1);
    expect(rows[0].skip).toBe(false);
    expect(rows[0].draft).toMatchObject({
      date: "2026-08-20",
      type: "sell",
      symbol: "KLAR",
      quantity: 50,
      price: 30,
      fees: 0.8,
    });
  });

  it("puts a symbol back on a dividend from the ledger's own names", () => {
    const csv = schwabRowsToCsv(
      [row({ type: "dividend", symbol: null, quantity: 0, price: 0, amount: 18.4, description: "GE VERNOVA INC" })],
      securities,
    );
    const table = parseDelimited(csv);
    const rows = buildImportRows(table, guessMapping(table.headers));

    expect(rows[0].draft).toMatchObject({ type: "dividend", symbol: "GEV", amount: 18.4 });
    expect(rows[0].skip).toBe(false);
  });

  it("leaves an unresolvable dividend blank so the review step catches it", () => {
    const csv = schwabRowsToCsv(
      [row({ type: "dividend", symbol: null, quantity: 0, price: 0, amount: 5, description: "MYSTERY HOLDING" })],
      securities,
    );
    const rows = buildImportRows(parseDelimited(csv), guessMapping(parseDelimited(csv).headers));
    expect(rows[0].skip).toBe(true);
    expect(rows[0].issues.join(" ")).toMatch(/symbol/i);
  });

  it("fingerprints on Schwab's own id, so a restated description still dedupes", () => {
    // Without the id in the row, the hash would rest on values Schwab can
    // revise, and a reworded description would import as a second copy.
    const first = schwabRowsToCsv([row({ activityId: "555", description: "BOUGHT QXO" })]);
    const second = schwabRowsToCsv([row({ activityId: "555", description: "BOUGHT QXO" })]);
    const hashOf = (csv: string) => {
      const t = parseDelimited(csv);
      return buildImportRows(t, guessMapping(t.headers))[0].draft.sourceHash;
    };
    expect(hashOf(first)).toBe(hashOf(second));

    const different = schwabRowsToCsv([row({ activityId: "556", description: "BOUGHT QXO" })]);
    expect(hashOf(different)).not.toBe(hashOf(first));
  });

  it("recognises a row already in the ledger", () => {
    const csv = schwabRowsToCsv([row({ activityId: "777" })]);
    const table = parseDelimited(csv);
    const once = buildImportRows(table, guessMapping(table.headers));
    const existing = [
      {
        ...once[0].draft,
        id: "t1",
        accountId: "a1",
        importBatchId: null,
      },
    ];
    const again = buildImportRows(table, guessMapping(table.headers), existing);
    expect(again[0].duplicate).toBe(true);
  });
});
