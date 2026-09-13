import { describe, expect, it } from "vitest";
import { projectionToCsv } from "./forecastCsv";
import { forecastScenario } from "@/engine/forecastScenario";
import { makeAccount, makeExpense, makeIncome, makeScenario } from "@/engine/testHelpers";

describe("projectionToCsv", () => {
  it("writes one row per year with the headline figures and every account", () => {
    const person = { id: "p", name: "Sam, Jr.", birthDate: "1980-06-01", retirementAge: 65, planningEndAge: 95 };
    const cash = makeAccount({ class: "cash", name: "Savings", startingBalance: 10_000, growthRatePct: 0 });
    const loan = makeAccount({ class: "loan", name: "Car loan", startingBalance: 5_000, growthRatePct: 0 });
    const scenario = makeScenario({
      accounts: [cash, loan],
      people: [person],
      incomeSources: [makeIncome({ amount: 3_000 })],
      expenses: [makeExpense({ amount: 1_000 })],
      horizonEndDate: "2027-12-31",
    });
    const csv = projectionToCsv(forecastScenario(scenario), [person]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    // A name with a comma is quoted; liabilities are written negative.
    expect(lines[0]).toContain('"Sam, Jr. age"');
    expect(lines[0].endsWith("Savings,Car loan")).toBe(true);
    const row = lines[1].split(",");
    expect(row[0]).toBe("2026");
    expect(row[1]).toBe("46");
    expect(row[row.length - 1]).toBe("-5000");
    // Income and expenses for the year, in the columns the header promises.
    // The quoted name holds a comma, so take it out before splitting on commas.
    const header = lines[0].replace('"Sam, Jr. age"', "Age").split(",");
    expect(row[header.indexOf("Income")]).toBe("36000");
    expect(row[header.indexOf("Expenses")]).toBe("12000");
  });
});
