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

  it("explains that growth rates are nominal rather than real", () => {
    expect(output).toContain("Growth rates are nominal");
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

  describe("engine context", () => {
    it("describes how the engine computes the forecast", () => {
      expect(output).toContain("## How the Forecast Engine Works");
      expect(output).toContain("month-by-month simulation");
    });

    it("states the model is deterministic, so the reader does not infer Monte Carlo", () => {
      expect(output).toContain("deterministic");
      expect(output).toContain("no Monte Carlo");
    });

    it("explains the surplus, deficit, and tax mechanics that drive the numbers", () => {
      expect(output).toContain("Surplus routing (the fill order)");
      expect(output).toContain("Deficit cascade (the drain order)");
      expect(output).toContain("average-cost basis");
      expect(output).toContain("RMD");
    });
  });

  describe("routing configuration", () => {
    it("spells out the actual hubs, fill order, and drain order rather than counts", () => {
      expect(output).toContain("## Money Flow / Routing");
      expect(output).toContain("### Spending hubs");
      expect(output).toContain("### Fill order");
      expect(output).toContain("### Drain order");
    });

    it("names each routed account and resolves ids to account names", () => {
      const named = (id: string) => mockScenario.accounts.find((a) => a.id === id)?.name;
      for (const hub of mockScenario.settings.moneyFlow.hubs) {
        expect(output).toContain(named(hub.accountId)!);
      }
      for (const stop of mockScenario.settings.moneyFlow.fillOrder) {
        expect(output).toContain(named(stop.accountId)!);
      }
      for (const stop of mockScenario.settings.moneyFlow.drainOrder) {
        expect(output).toContain(named(stop.accountId)!);
      }
    });

    it("reports the split modes, which change how stops are filled and drained", () => {
      expect(output).toContain(mockScenario.settings.moneyFlow.fillSplitMode);
      expect(output).toContain(mockScenario.settings.moneyFlow.drainSplitMode);
    });
  });

  describe("per-item detail", () => {
    it("records where each income source deposits and each expense pays from", () => {
      expect(output).toContain("deposits to");
      expect(output).toContain("paid from");
    });

    it("labels Social Security and pension amounts as gross", () => {
      const hasGrossIncome = mockScenario.incomeSources.some(
        (i) => i.category === "social_security" || i.category === "pension"
      );
      if (hasGrossIncome) expect(output).toContain("**gross (pre-tax)**");
    });

    it("avoids the ungrammatical 'per monthly' phrasing", () => {
      expect(output).not.toContain("per monthly");
      expect(output).not.toContain("per one_time");
    });
  });

  describe("projection results", () => {
    it("includes a year-by-year table covering the whole horizon", () => {
      expect(output).toContain("## Year-by-Year Projection");
      expect(output).toContain("| Year | Income | Expenses | Federal tax |");
      const startYear = Number(mockScenario.settings.startDate.slice(0, 4));
      const endYear = Number(mockScenario.settings.horizonEndDate.slice(0, 4));
      expect(output).toContain(`| ${startYear} |`);
      expect(output).toContain(`| ${endYear} |`);
    });

    it("includes ending balances per account", () => {
      expect(output).toContain("### Ending account balances");
    });
  });

  describe("levers", () => {
    it("tells the reader which inputs are editable", () => {
      expect(output).toContain("## Levers — Every Input the User Can Change");
      expect(output).toContain("Routing tab");
      expect(output).toContain("isExcluded");
    });

    it("warns which values are derived and cannot be edited directly", () => {
      expect(output).toContain("derived");
    });
  });

  it("still produces the inputs when the projection cannot be computed", () => {
    // A horizon that ends before it starts yields no months to simulate; the
    // export must degrade to inputs-only rather than throwing.
    const broken = {
      ...mockScenario,
      settings: { ...mockScenario.settings, horizonEndDate: "1999-01-01" },
    };
    const brokenOutput = buildLlmExport(broken);
    expect(brokenOutput).toContain("## Accounts");
    expect(brokenOutput).toContain("## Levers");
  });
});
