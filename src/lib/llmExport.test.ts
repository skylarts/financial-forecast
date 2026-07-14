import { describe, expect, it } from "vitest";
import { buildLlmExport } from "./llmExport";
import { mockScenario } from "./mockScenario";

describe("buildLlmExport", () => {
  const output = buildLlmExport(mockScenario);

  it("includes a glossary explaining net vs gross income and account terminology", () => {
    expect(output).toContain("## Glossary");
    expect(output).toContain("take-home");
    expect(output).toContain("Social Security & pension are gross");
  });

  it("includes a section per data area", () => {
    expect(output).toContain("## Household");
    expect(output).toContain("## Settings");
    expect(output).toContain("## Accounts");
    expect(output).toContain("## Income Sources");
    expect(output).toContain("## Expenses");
    expect(output).toContain("## Events");
  });

  it("lists each person, account, income source, and expense by name", () => {
    for (const p of mockScenario.household.people) expect(output).toContain(p.name);
    for (const a of mockScenario.accounts) expect(output).toContain(a.name);
    for (const inc of mockScenario.incomeSources) expect(output).toContain(inc.name);
    for (const exp of mockScenario.expenses) expect(output).toContain(exp.name);
  });

  it("includes a projected summary with net worth figures", () => {
    expect(output).toContain("## Projected Summary (KPIs)");
    expect(output).toContain("Net worth at end of plan");
  });
});
