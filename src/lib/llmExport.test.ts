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
      expect(output).toContain("Surplus split (Extra Savings)");
      expect(output).toContain("Deficit cascade (the drain order)");
      expect(output).toContain("average-cost basis");
      expect(output).toContain("RMD");
    });
  });

  describe("routing configuration", () => {
    it("spells out Extra Savings, the split order, and the drain order rather than counts", () => {
      expect(output).toContain("## Money Flow / Routing");
      expect(output).toContain("### Extra Savings");
      expect(output).toContain("### Split order");
      expect(output).toContain("### Drain order");
    });

    it("names each routed account and resolves ids to account names", () => {
      const named = (id: string) => mockScenario.accounts.find((a) => a.id === id)?.name;
      const extraSavings = mockScenario.accounts.find((a) => a.isExtraSavings);
      expect(extraSavings).toBeDefined();
      expect(output).toContain(extraSavings!.name);
      for (const stop of mockScenario.settings.moneyFlow.splitOrder) {
        expect(output).toContain(named(stop.accountId)!);
      }
      for (const stop of mockScenario.settings.moneyFlow.drainOrder) {
        expect(output).toContain(named(stop.accountId)!);
      }
    });

    it("reports the drain split mode, which changes how stops are drained", () => {
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
      const startYear = Number(mockScenario.settings.startDate!.slice(0, 4));
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

  describe("fields that are stored/engine-consumed but easy to forget in the export", () => {
    it("flags an account with a future startDate as not-yet-existing", () => {
      const home = mockScenario.accounts.find((a) => a.name === "Buy a home")!;
      expect(output).toContain(`Doesn't exist until ${home.startDate}`);
    });

    it("reports an account's starting cost basis when set", () => {
      const [first, ...rest] = mockScenario.accounts;
      const withBasis = {
        ...mockScenario,
        accounts: [{ ...first, startingBalance: 40_000, startingCostBasis: 25_000 }, ...rest],
      };
      const out = buildLlmExport(withBasis);
      expect(out).toContain("Starting cost basis");
      expect(out).toContain("$25,000");
    });

    it("flags an account exempt from the early-withdrawal penalty", () => {
      const [first, ...rest] = mockScenario.accounts;
      const exempt = {
        ...mockScenario,
        accounts: [{ ...first, noEarlyWithdrawalPenalty: true }, ...rest],
      };
      const out = buildLlmExport(exempt);
      expect(out).toContain("exempt from the 10% early-withdrawal penalty");
    });

    it("reports an income source's gross (Box-1-style) amount when set", () => {
      const [first, ...rest] = mockScenario.incomeSources;
      const withGross = {
        ...mockScenario,
        incomeSources: [{ ...first, grossAmount: 9_000 }, ...rest],
      };
      const out = buildLlmExport(withGross);
      expect(out).toContain("Gross (Box-1-style) amount");
      expect(out).toContain("$9,000");
    });

    it("explains that sellingCostsPct overrides a fixed netProceeds on sell_home", () => {
      const home = mockScenario.accounts.find((a) => a.name === "Buy a home")!;
      const withSale = {
        ...mockScenario,
        events: [
          ...mockScenario.events,
          {
            id: "sell-home-test",
            type: "sell_home" as const,
            name: "Sell the home",
            startDate: "2070-01-01",
            realEstateAccountId: home.id,
            netProceeds: 100_000,
            sellingCostsPct: 0.06,
            proceedsAccountId: null,
          },
        ],
      };
      const out = buildLlmExport(withSale);
      expect(out).toContain("proceeds are **computed from the projection**");
      expect(out).toContain("ignored while sellingCostsPct is set");
    });

    it("includes temporary adjustment windows on a retirement event's retirementExpense", () => {
      const retireEvent = mockScenario.events.find((e) => e.type === "retire")!;
      const withAdjustment = {
        ...mockScenario,
        events: mockScenario.events.map((e) =>
          e.id === retireEvent.id
            ? {
                ...e,
                retirementExpense: {
                  amount: 12_000,
                  growthRatePct: 0.03,
                  paymentAccountId: null,
                  endDate: null,
                  adjustments: [
                    { id: "adj-1", startDate: "2056-01-01", endDate: "2058-01-01", multiplier: 1.5, note: "extra travel" },
                  ],
                },
              }
            : e
        ),
      };
      const out = buildLlmExport(withAdjustment);
      expect(out).toContain("extra travel");
    });

    it("distinguishes an explicit 0% custom_transfer growth rate from an unset one (matches inflation)", () => {
      const withTransfer = {
        ...mockScenario,
        events: [
          ...mockScenario.events,
          {
            id: "transfer-test",
            type: "custom_transfer" as const,
            name: "Flat transfer",
            startDate: "2030-01-01",
            amount: 100,
            fromAccountId: mockScenario.accounts[1].id,
            toAccountId: mockScenario.accounts[2].id,
            frequency: "monthly" as const,
            growthRatePct: 0,
          },
        ],
      };
      const out = buildLlmExport(withTransfer);
      expect(out).toContain("flat in nominal terms (0% growth)");
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
