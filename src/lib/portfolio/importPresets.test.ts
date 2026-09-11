import { describe, expect, it } from "vitest";
import { buildImportRows, guessMapping, parseDelimited } from "./importer";
import { detectPreset, presetById } from "./importPresets";

/** Rows for `text` the way the dialog builds them: detected preset, its
 *  columns over the guessed ones, and whatever aliases the caller supplies. */
function rowsFor(text: string, aliases: Record<string, string> = {}) {
  const table = parseDelimited(text);
  const preset = detectPreset(table.headers, table.rows);
  const mapping = { ...guessMapping(table.headers), ...(preset?.mapping(table.headers) ?? {}) };
  return { preset, rows: buildImportRows(table, mapping, [], null, { preset, symbolAliases: aliases }) };
}

describe("detectPreset", () => {
  it("knows Schwab's transactions download by its columns", () => {
    const table = parseDelimited(
      '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"\n"08/07/2026","Buy","Z","ZILLOW","10","$33.48","","-$334.80"',
    );
    expect(detectPreset(table.headers, table.rows)?.id).toBe("schwab");
  });

  it("knows Fidelity's history download, preamble and all", () => {
    const table = parseDelimited(
      "\n\nRun Date,Action,Symbol,Description,Type,Exchange Quantity,Exchange Currency,Currency,Price,Quantity,Exchange Rate,Commission,Fees,Accrued Interest,Amount,Cash Balance,Settlement Date\n06/03/2026,YOU BOUGHT MICROSOFT CORP (MSFT) (Margin),MSFT,MICROSOFT CORP,Margin,0,,USD,400,1,0,,,,-400,0,06/04/2026",
    );
    expect(detectPreset(table.headers, table.rows)?.id).toBe("fidelity");
  });

  it("knows a workplace plan export by Investment, Activity and Units", () => {
    const table = parseDelimited(
      '"Transaction Date","Investment","Contribution","Description","Activity","Price","Units","Amount",\n"8/28/2026 12:00:00 AM","Cash","Employer Match","Contributions - Employer","Cash Receipts","1.000000","0.000000000","261.10",',
    );
    expect(detectPreset(table.headers, table.rows)?.id).toBe("workplace");
  });

  it("knows this app's own export by its exact type names", () => {
    const table = parseDelimited(
      "Date,Action,Symbol,Quantity,Price,Amount,Fees,Lot ID,Date Acquired,Description\n2022-03-15,buy,AAPL,0.05,158.57,8,0,AAPL-1,,APPLE",
    );
    expect(detectPreset(table.headers, table.rows)?.id).toBe("ledger");
  });

  it("claims nothing for a file it has not been taught", () => {
    const table = parseDelimited("When,What,Ticker,How many\n2024-01-10,Bought,VTI,10");
    expect(detectPreset(table.headers, table.rows)).toBeNull();
  });
});

describe("Schwab preset", () => {
  const schwab = presetById("schwab");
  const facts = (action: string, extra: Partial<Parameters<typeof schwab.resolve>[0]> = {}) =>
    schwab.resolve({ action, description: "", symbol: "", quantity: null, price: null, amount: null, ...extra });

  it("types the two-row reinvestment the way the cash moves", () => {
    expect(facts("Reinvest Dividend").type).toBe("dividend");
    expect(facts("Qual Div Reinvest").type).toBe("dividend");
    expect(facts("Reinvest Shares").type).toBe("reinvest");
  });

  it("reads journals and MoneyLink rows from the sign of the amount", () => {
    expect(facts("Journal", { amount: -6999.59 }).type).toBe("cash_withdrawal");
    expect(facts("MoneyLink Transfer", { amount: 1000 }).type).toBe("cash_deposit");
    expect(facts("Wire Received", { amount: 500 }).type).toBe("cash_deposit");
  });

  it("reads a security transfer from the sign of the quantity", () => {
    expect(facts("Security Transfer", { quantity: 10 }).type).toBe("transfer_in");
    expect(facts("Security Transfer", { quantity: -10 }).type).toBe("transfer_out");
  });

  it("maps the option lifecycle and the fee wording", () => {
    expect(facts("Sell to Open").type).toBe("short_sell");
    expect(facts("Buy to Close").type).toBe("buy_to_cover");
    expect(facts("Assigned").type).toBe("option_assign");
    expect(facts("Expired").type).toBe("option_expire");
    expect(facts("Foreign Tax Paid").type).toBe("fee");
    expect(facts("Bank Interest").type).toBe("interest");
  });

  it("refuses to type a split row, and says why", () => {
    const resolved = facts("Stock Split", { quantity: 90 });
    expect(resolved.type).toBeNull();
    expect(resolved.hint).toMatch(/ratio/);
  });

  it("does not know wording it has never seen", () => {
    expect(facts("Cash In Lieu").type).toBeNull();
  });

  it("marks an unlisted action for review rather than importing a guess", () => {
    const { rows } = rowsFor(
      '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"\n' +
        '"08/07/2026","Buy","Z","ZILLOW","10","$33.48","","-$334.80"\n' +
        '"08/06/2026","ACH Deposit","","","","","","$12.10"',
    );
    expect(rows[0].typeSource).toBe("preset");
    expect(rows[0].unrecognised).toBe(false);
    // The wording still yields a type, so the row is importable -- once someone says so.
    expect(rows[1].draft.type).toBe("cash_deposit");
    expect(rows[1].typeSource).toBe("pattern");
    expect(rows[1].unrecognised).toBe(true);
    expect(rows[1].skip).toBe(false);
    expect(rows[1].action).toBe("ACH Deposit");
    expect(rows[1].issues[0]).toMatch(/isn't in the Schwab CSV table/);
  });
});

describe("Fidelity preset", () => {
  const HEADER =
    "Run Date,Action,Symbol,Description,Type,Exchange Quantity,Exchange Currency,Currency,Price,Quantity,Exchange Rate,Commission,Fees,Accrued Interest,Amount,Cash Balance,Settlement Date";

  it("reads the ticker out of the action text when the symbol column is blank", () => {
    const { preset, rows } = rowsFor(
      `${HEADER}\n06/03/2026,YOU BOUGHT MICROSOFT CORP (MSFT) (Margin),,MICROSOFT CORP,Margin,0,,USD,400,1,0,,,,-400,0,06/04/2026`,
    );
    expect(preset?.id).toBe("fidelity");
    expect(rows[0].draft.type).toBe("buy");
    expect(rows[0].draft.symbol).toBe("MSFT");
    expect(rows[0].unrecognised).toBe(false);
  });

  it("builds an option contract from the prose", () => {
    const { rows } = rowsFor(
      `${HEADER}\n12/10/2025,"YOU BOUGHT OPENING TRANSACTION CALL (MQ) MARQETA INC CLASS A JAN 15 27 $5.5 (100 SHS) (Cash)",,MARQETA,Cash,0,,USD,0.9,1,0,,0.65,,-90.66,0,12/11/2025`,
    );
    expect(rows[0].draft.type).toBe("buy");
    expect(rows[0].draft.symbol).toBe("MQ270115C00005500");
  });

  it("accepts Fidelity's dashed contract symbol", () => {
    const { rows } = rowsFor(
      `${HEADER}\n09/17/2025,"YOU BOUGHT OPENING TRANSACTION PUT (BABA) ALIBABA GROUP JAN 15 27 $50 (100 SHS) (Margin)", -BABA270115P50,ALIBABA,Margin,0,,USD,0.31,1,0,,0.65,,-31.67,0,09/18/2025`,
    );
    expect(rows[0].draft.symbol).toBe("BABA270115P00050000");
  });

  it("keeps short sales and covers apart from ordinary trades", () => {
    const { rows } = rowsFor(
      `${HEADER}\n01/05/2026,YOU SOLD SHORT SALE PROSHARES TR II ULTRA VIX SHORT (UVXY) (Short),UVXY,UVXY,Short,0,,USD,20,-10,0,,,,200,0,01/06/2026\n01/12/2026,YOU BOUGHT SHORT COVER PROSHARES TR II ULTRA VIX SHORT (UVXY) (Short),UVXY,UVXY,Short,0,,USD,18,10,0,,,,-180,0,01/13/2026`,
    );
    expect(rows[0].draft.type).toBe("short_sell");
    expect(rows[1].draft.type).toBe("buy_to_cover");
  });

  it("drops the margin mark-to-market bookkeeping without importing it", () => {
    const { rows } = rowsFor(
      `${HEADER}\n04/02/2026,SHORT VS MARGIN MARK TO MARKET (Margin),,No Description,Margin,0,,USD,,0,0,,,,-6,0,`,
    );
    expect(rows[0].ignored).toMatch(/moves no money/i);
    expect(rows[0].skip).toBe(true);
    expect(rows[0].unrecognised).toBe(false);
  });

  it("reads deposits, fees and cash transfers between Fidelity accounts", () => {
    const { rows } = rowsFor(
      `${HEADER}\n` +
        `03/01/2026,Electronic Funds Transfer Received (Cash),,No Description,Cash,0,,USD,,0,0,,,,500,0,\n` +
        `03/02/2026,FEE CHARGED Fidelity Basket Portfolios (Cash),,No Description,Cash,0,,USD,,0,0,,,,-4.99,0,\n` +
        `03/03/2026,TRANSFERRED TO VS Z39-134230-1 (Cash),,No Description,Cash,0,,USD,,0,0,,,,-250,0,`,
    );
    expect(rows.map((r) => r.draft.type)).toEqual(["cash_deposit", "fee", "cash_withdrawal"]);
    expect(rows.every((r) => !r.unrecognised)).toBe(true);
  });

  it("holds a distribution it cannot classify for a decision", () => {
    const { rows } = rowsFor(
      `${HEADER}\n02/19/2026,DISTRIBUTION MARQETA INC CLASS A COM 1 FOR 4 R/S (Margin),MQ,MARQETA,Margin,0,,USD,,-150,0,,,,0,0,`,
    );
    expect(rows[0].unrecognised).toBe(true);
  });
});

describe("workplace plan preset", () => {
  const HEADER = '"Transaction Date","Investment","Contribution","Description","Activity","Price","Units","Amount",';
  const line = (date: string, inv: string, src: string, desc: string, act: string, price: string, units: string, amount: string) =>
    `"${date}","${inv}","${src}","${desc}","${act}","${price}","${units}","${amount}",`;

  it("keeps both halves of a contribution and routes by money source", () => {
    const { preset, rows } = rowsFor(
      [
        HEADER,
        line("8/28/2026 12:00:00 AM", "Cash", "Employer Match", "Contributions - Employer", "Cash Receipts", "1.000000", "0.000000000", "261.10"),
        line("8/28/2026 12:00:00 AM", "Schwab 1000 Index", "Employer Match", "Contributions - Employer", "Purchase", "12.500000", "20.888000000", "261.10"),
      ].join("\n"),
    );
    expect(preset?.id).toBe("workplace");
    expect(rows[0].draft.type).toBe("cash_deposit");
    expect(rows[0].draft.symbol).toBeNull();
    expect(rows[0].taxSourceLabel).toBe("Employer Match");
    expect(rows[1].draft.type).toBe("buy");
    // Known from the app's own confirmed table, with nothing typed.
    expect(rows[1].draft.symbol).toBe("SNXFX");
    expect(rows[1].draft.date).toBe("2026-08-28");
  });

  it("tells a reinvested distribution from a contribution purchase", () => {
    const { rows } = rowsFor(
      [
        HEADER,
        line("3/31/2026 12:00:00 AM", "Schwab 1000 Index", "Employee Deferral", "Dividends/Capital Gains", "Cash Receipts", "1.000000", "0.000000000", "40.00"),
        line("3/31/2026 12:00:00 AM", "Schwab 1000 Index", "Employee Deferral", "Dividends/Capital Gains", "Purchase", "12.500000", "3.200000000", "40.00"),
        line("3/31/2026 12:00:00 AM", "Schwab 1000 Index", "Employee Deferral", "Interest Earned", "Cash Receipts", "1.000000", "0.000000000", "0.10"),
      ].join("\n"),
    );
    expect(rows[0].draft.type).toBe("dividend");
    expect(rows[0].draft.symbol).toBe("SNXFX");
    expect(rows[1].draft.type).toBe("reinvest");
    expect(rows[2].draft.type).toBe("interest");
    expect(rows[2].draft.symbol).toBeNull();
  });

  it("drops cash moving within the cash fund", () => {
    const { rows } = rowsFor(
      [HEADER, line("3/31/2026 12:00:00 AM", "Cash", "Employer Match", "Contributions - Employer", "Purchase", "1.000000", "261.100000000", "261.10")].join("\n"),
    );
    expect(rows[0].ignored).toBeTruthy();
    expect(rows[0].skip).toBe(true);
  });

  it("will not import a fund whose ticker nobody has given", () => {
    const { rows } = rowsFor(
      [HEADER, line("3/31/2026 12:00:00 AM", "Some Collective Trust Pool", "Employer Match", "Contributions - Employer", "Purchase", "10", "5", "50")].join("\n"),
    );
    expect(rows[0].skip).toBe(true);
    expect(rows[0].issues.join(" ")).toMatch(/No ticker for "Some Collective Trust Pool"/);
    expect(rows[0].draft.symbol).toBeNull();
  });

  it("uses a typed ticker over nothing, and never stores the fund's name", () => {
    const { rows } = rowsFor(
      [HEADER, line("3/31/2026 12:00:00 AM", "Some Collective Trust Pool", "Employer Match", "Contributions - Employer", "Purchase", "10", "5", "50")].join("\n"),
      { "Some Collective Trust Pool": "fssnx" },
    );
    expect(rows[0].skip).toBe(false);
    expect(rows[0].draft.symbol).toBe("FSSNX");
  });
});

describe("without a preset", () => {
  it("holds only sign-read types for a decision", () => {
    const table = parseDelimited(
      "Date,Action,Symbol,Quantity,Amount\n01/10/2024,Bought,VTI,10,-1000\n01/11/2024,,VTI,5,-500",
    );
    const rows = buildImportRows(table, guessMapping(table.headers));
    expect(rows[0].typeSource).toBe("pattern");
    expect(rows[0].unrecognised).toBe(false);
    expect(rows[1].typeSource).toBe("sign");
    expect(rows[1].unrecognised).toBe(true);
  });

  it("still reads this app's own type names as exact", () => {
    const table = parseDelimited("Date,Action,Symbol,Quantity,Price\n2024-01-10,buy_to_cover,UVXY,10,18");
    const [row] = buildImportRows(table, guessMapping(table.headers));
    expect(row.typeSource).toBe("exact");
    expect(row.draft.type).toBe("buy_to_cover");
  });
});
