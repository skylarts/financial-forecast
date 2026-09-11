import { describe, expect, it } from "vitest";
import { dedupeByDate, parseStatementValuations } from "./statementValuations";

describe("parseStatementValuations", () => {
  it("reads a terminal export's valuations array", () => {
    const { rows, skipped } = parseStatementValuations(
      JSON.stringify({
        valuations: [
          { month: "2026-07", npv: 35302.52, contrib: 400, dividends: 8.14, gains: -59.14 },
          { month: "2026-08", npv: 35778.69, contrib: 0, dividends: 0, gains: 476.17 },
        ],
        shares: [{ symbol: "AMZN" }],
      }),
    );
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-07-31", value: 35302.52, contributions: 400, income: 8.14 });
    expect(rows[1].date).toBe("2026-08-31");
  });

  it("dates YYYY-MM to the last day of that month, leap years included", () => {
    const { rows } = parseStatementValuations(
      JSON.stringify([
        { month: "2024-02", npv: 1 },
        { month: "2025-02", npv: 2 },
        { month: "2026-04", npv: 3 },
      ]),
    );
    expect(rows.map((r) => r.date)).toEqual(["2024-02-29", "2025-02-28", "2026-04-30"]);
  });

  it("takes an exact date as given", () => {
    const { rows } = parseStatementValuations(JSON.stringify([{ date: "2026-08-14", value: 5 }]));
    expect(rows[0].date).toBe("2026-08-14");
  });

  it("reads a CSV with a header row", () => {
    const { rows, skipped } = parseStatementValuations(
      ["date,value,contributions", "2026-07-31,$35302.52,400.00", "2026-08-31,\"35,778.69\",0"].join("\n"),
    );
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBeCloseTo(35302.52);
    expect(rows[1].value).toBeCloseTo(35778.69);
  });

  it("reads accounting parentheses as negative", () => {
    const { rows } = parseStatementValuations(["month,npv,contributions", "2026-08,1000,(250.00)"].join("\n"));
    expect(rows[0].contributions).toBe(-250);
  });

  it("accepts MM/DD/YYYY", () => {
    const { rows } = parseStatementValuations(["date,value", "08/31/2026,100"].join("\n"));
    expect(rows[0].date).toBe("2026-08-31");
  });

  it("names rows it cannot read instead of dropping them silently", () => {
    const { rows, skipped } = parseStatementValuations(
      ["date,value", "2026-08-31,100", "not-a-date,100", "2026-09-30,"].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(skipped).toHaveLength(2);
  });

  it("refuses a month outside 1-12", () => {
    const { rows, skipped } = parseStatementValuations(JSON.stringify([{ month: "2026-13", npv: 1 }]));
    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("reports invalid JSON rather than throwing", () => {
    const { rows, skipped } = parseStatementValuations("{ nope");
    expect(rows).toEqual([]);
    expect(skipped[0]).toMatch(/not valid JSON/);
  });

  it("is empty for empty input", () => {
    expect(parseStatementValuations("   ")).toEqual({ rows: [], skipped: [] });
  });
});

describe("dedupeByDate", () => {
  it("keeps the later row for a repeated period end and sorts by date", () => {
    const out = dedupeByDate([
      { date: "2026-08-31", value: 1, contributions: null, income: null, note: "" },
      { date: "2026-07-31", value: 2, contributions: null, income: null, note: "" },
      { date: "2026-08-31", value: 3, contributions: null, income: null, note: "" },
    ]);
    expect(out.map((r) => r.date)).toEqual(["2026-07-31", "2026-08-31"]);
    expect(out[1].value).toBe(3);
  });
});
