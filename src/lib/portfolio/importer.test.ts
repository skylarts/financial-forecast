import { describe, expect, it } from "vitest";
import {
  buildImportRows,
  guessMapping,
  inferType,
  isDirectionlessTransfer,
  parseDate,
  parseDelimited,
  parseNumber,
} from "./importer";

describe("parseDelimited", () => {
  it("skips a brokerage preamble and finds the real header row", () => {
    const table = parseDelimited(
      [
        "Transaction History for Account X12-345678",
        "Generated 08/04/2026",
        "",
        "Run Date,Action,Symbol,Quantity,Price,Amount",
        "01/10/2024,YOU BOUGHT,VTI,10,100.00,-1000.00",
      ].join("\n"),
    );

    expect(table.headers).toEqual(["Run Date", "Action", "Symbol", "Quantity", "Price", "Amount"]);
    expect(table.rows).toHaveLength(1);
  });

  it("honors quoted fields containing commas", () => {
    const table = parseDelimited(
      ['Date,Description,Amount', '01/10/2024,"VANGUARD, TOTAL MARKET",1000.00'].join("\n"),
    );

    expect(table.rows[0]).toEqual(["01/10/2024", "VANGUARD, TOTAL MARKET", "1000.00"]);
  });

  it("reads a markdown table and drops the divider row", () => {
    const table = parseDelimited(
      [
        "| Date | Action | Symbol | Quantity | Price |",
        "| --- | --- | --- | --- | --- |",
        "| 2024-01-10 | Buy | VTI | 10 | 100 |",
        "| 2024-02-10 | Sell | VTI | 5 | 120 |",
      ].join("\n"),
    );

    expect(table.headers).toEqual(["Date", "Action", "Symbol", "Quantity", "Price"]);
    expect(table.rows).toHaveLength(2);
  });
});

describe("guessMapping", () => {
  it("maps a typical export", () => {
    const mapping = guessMapping(["Run Date", "Action", "Symbol", "Quantity", "Price", "Amount"]);
    expect(mapping).toMatchObject({ date: 0, type: 1, symbol: 2, quantity: 3, price: 4, amount: 5 });
  });

  it("does not let 'Date' steal the 'Date Acquired' column", () => {
    const mapping = guessMapping(["Trade Date", "Date Acquired", "Symbol", "Quantity"]);
    expect(mapping.date).toBe(0);
    expect(mapping.acquiredDate).toBe(1);
  });

  it("keeps fees separate from amount", () => {
    const mapping = guessMapping(["Date", "Action", "Symbol", "Fees & Comm", "Amount"]);
    expect(mapping.fees).toBe(3);
    expect(mapping.amount).toBe(4);
  });
});

describe("parseDate", () => {
  it.each([
    ["01/10/2024", "2024-01-10"],
    ["1/5/24", "2024-01-05"],
    ["2024-01-10", "2024-01-10"],
    ["10-Jan-2024", "2024-01-10"],
    ["Jan 10, 2024", "2024-01-10"],
    ["01/10/2024 as of 01/08/2024", "2024-01-10"],
  ])("reads %s", (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it("returns null on unreadable input", () => {
    expect(parseDate("sometime last year")).toBeNull();
  });
});

describe("parseNumber", () => {
  it.each([
    ["$1,234.56", 1234.56],
    ["-1,234.56", -1234.56],
    ["(1,234.56)", -1234.56],
    ["10", 10],
  ])("reads %s", (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it("returns null on blanks and placeholders", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("N/A")).toBeNull();
    expect(parseNumber("—")).toBeNull();
  });
});

describe("inferType", () => {
  it.each([
    ["YOU BOUGHT", "buy"],
    ["You Sold", "sell"],
    ["DIVIDEND RECEIVED", "dividend"],
    ["REINVESTMENT", "reinvest"],
    ["Stock Split", "split"],
    ["Wire Funds Received", "cash_deposit"],
    ["Foreign Tax Fee", "fee"],
  ])("maps %s", (input, expected) => {
    expect(inferType(input)).toBe(expected);
  });

  it("prefers reinvestment over the dividend wording it contains", () => {
    expect(inferType("DIVIDEND REINVESTMENT")).toBe("reinvest");
  });
});

describe("buildImportRows", () => {
  const csv = [
    "Run Date,Action,Symbol,Quantity,Price,Amount",
    "01/10/2024,YOU BOUGHT,VTI,10,100.00,-1000.00",
    "04/15/2024,DIVIDEND RECEIVED,VTI,,,42.00",
    "06/01/2024,YOU SOLD,vti,-5,120.00,600.00",
  ].join("\n");

  function rows() {
    const table = parseDelimited(csv);
    return buildImportRows(table, guessMapping(table.headers));
  }

  it("normalizes direction and case off the source rows", () => {
    const [buy, dividend, sell] = rows();

    expect(buy.draft).toMatchObject({ date: "2024-01-10", type: "buy", symbol: "VTI", quantity: 10, amount: 1000 });
    expect(dividend.draft).toMatchObject({ type: "dividend", amount: 42 });
    expect(sell.draft).toMatchObject({ type: "sell", symbol: "VTI", quantity: 5, amount: 600 });
    expect(rows().every((r) => !r.skip)).toBe(true);
  });

  it("flags rows it cannot understand instead of importing a guess", () => {
    const table = parseDelimited("Date,Action,Symbol,Quantity\nnot a date,Buy,VTI,10");
    const [row] = buildImportRows(table, guessMapping(table.headers));

    expect(row.skip).toBe(true);
    expect(row.issues.join(" ")).toContain("No date");
  });

  it("infers a missing type from the sign of the amount and says so", () => {
    const table = parseDelimited("Date,Symbol,Quantity,Amount\n01/10/2024,VTI,10,-1000");
    const [row] = buildImportRows(table, guessMapping(table.headers));

    expect(row.draft.type).toBe("buy");
    expect(row.issues.join(" ")).toContain("read as a buy");
    expect(row.skip).toBe(false);
  });

  it("marks rows already present in the ledger as duplicates", () => {
    const first = rows();
    const existing = first.map((row, i) => ({
      ...row.draft,
      id: `tx-${i}`,
      accountId: "acct-1",
      importBatchId: null,
    }));

    const second = rows().map((row) => ({
      ...row,
      duplicate: buildImportRows(parseDelimited(csv), guessMapping(parseDelimited(csv).headers), existing)[0]
        .duplicate,
    }));

    expect(second[0].duplicate).toBe(true);
  });
});

describe("buildImportRows: spinoff", () => {
  const header = "Date,Action,Symbol,Spinoff: new symbol,Spinoff: share ratio,Spinoff: basis retained";

  function rows(dataLine: string) {
    const table = parseDelimited([header, dataLine].join("\n"));
    return buildImportRows(table, guessMapping(table.headers));
  }

  it("maps the three spinoff columns onto the draft", () => {
    const [row] = rows("09/30/2023,spinoff,DHR,VLTO,0.3333,0.8834");

    expect(row.skip).toBe(false);
    expect(row.draft).toMatchObject({
      type: "spinoff",
      symbol: "DHR",
      spinoffSymbol: "VLTO",
      spinoffShareRatio: 0.3333,
      spinoffBasisRetained: 0.8834,
    });
  });

  it("recognizes spinoff wording in the action column via free text", () => {
    expect(inferType("Spinoff")).toBe("spinoff");
    expect(inferType("Stock Merger")).toBe("spinoff");
  });

  it("skips a spinoff row missing its ratio or basis, rather than importing a no-op", () => {
    const [row] = rows("09/30/2023,spinoff,DHR,VLTO,,");

    expect(row.skip).toBe(true);
    expect(row.issues.join(" ")).toContain("share ratio");
  });
});

describe("directionless transfer wording", () => {
  it.each(["Transfer (Securities)", "Transfer (Cash/ACAT)", "ACAT"])(
    "leaves %s untyped on wording alone",
    (input) => {
      expect(inferType(input)).toBeNull();
      expect(isDirectionlessTransfer(input)).toBe(true);
    },
  );

  it.each(["Transfer In", "Transfer Out", "YOU BOUGHT"])(
    "does not claim %s, which already resolves",
    (input) => {
      expect(isDirectionlessTransfer(input)).toBe(false);
    },
  );

  function transferRows(csv: string) {
    const table = parseDelimited(csv);
    return buildImportRows(table, guessMapping(table.headers));
  }

  // Both halves of a custodian move must survive. Dropping the outbound half is
  // what leaves shares in the ledger that nothing ever paid for, so whatever
  // closes them later gets booked against a zero cost basis.
  it("reads a securities transfer's direction from the quantity's sign", () => {
    const [out, back] = transferRows(
      [
        "Run Date,Action,Symbol,Quantity,Price,Amount",
        "12/05/2025,Transfer (Securities),AMZN,-11,,",
        "12/08/2025,Transfer In,AMZN,11,,",
      ].join("\n"),
    );

    expect(out.skip).toBe(false);
    expect(out.draft.type).toBe("transfer_out");
    expect(out.draft.quantity).toBe(11);
    expect(out.issues[0]).toMatch(/direction not stated/i);
    expect(back.draft.type).toBe("transfer_in");
  });

  it("reads a cash transfer's direction from the amount when it moves no shares", () => {
    const [inbound, outbound] = transferRows(
      [
        "Run Date,Action,Symbol,Quantity,Price,Amount",
        "12/05/2025,Transfer (Cash/ACAT),,,,119.55",
        "12/15/2025,Transfer (Cash/ACAT),,,,-40.00",
      ].join("\n"),
    );

    expect(inbound.skip).toBe(false);
    expect(inbound.draft.type).toBe("cash_deposit");
    expect(outbound.draft.type).toBe("cash_withdrawal");
  });

  it("still skips a transfer that carries no sign to read", () => {
    const [row] = transferRows(
      ["Run Date,Action,Symbol,Quantity,Price,Amount", "12/05/2025,Transfer (Securities),AMZN,,,"].join(
        "\n",
      ),
    );

    expect(row.skip).toBe(true);
    expect(row.issues.join(" ")).toMatch(/could not tell/i);
  });
});
