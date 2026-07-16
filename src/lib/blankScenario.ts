import { nanoid } from "nanoid";
import { scenarioSchema } from "@/domain";

/** A minimal, empty starting point for "start from scratch" scenario creation. */
export function makeBlankScenario(name: string) {
  const personId = nanoid();
  const startYear = new Date().getFullYear();
  return scenarioSchema.parse({
    id: nanoid(),
    name,
    household: {
      people: [{ id: personId, name: "You", birthDate: `${startYear - 35}-01-01`, retirementAge: 65, planningEndAge: 95 }],
    },
    accounts: [],
    incomeSources: [],
    expenses: [],
    events: [],
    settings: {
      startDate: `${startYear}-01-01`,
      horizonEndDate: `${startYear + 60}-12-31`,
      inflationRatePct: 0.03,
      moneyFlow: {
        splitOrder: [],
        drainOrder: [],
        drainSplitMode: "priority_fill",
      },
      rmdEnabled: true,
      filingStatus: "single",
      additionalFlatTaxRatePct: 0,
    },
  });
}
