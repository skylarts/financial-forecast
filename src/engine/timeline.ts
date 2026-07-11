import type { Scenario, ScenarioEvent, TimelineRow } from "@/domain";
import { ageOn, yearOf } from "./dateMath";

export function buildTimeline(scenario: Scenario): TimelineRow[] {
  const personName = (id: string | null) =>
    scenario.household.people.find((p) => p.id === id)?.name ?? "Someone";
  const accountName = (id: string) =>
    scenario.accounts.find((a) => a.id === id)?.name ?? "an account";

  return scenario.events.map((event: ScenarioEvent) => {
    let description: string;
    switch (event.type) {
      case "retire": {
        const person = scenario.household.people.find((p) => p.id === event.personId);
        const age = person ? ageOn(person.birthDate, event.startDate) : null;
        description = `${personName(event.personId)} retires${age !== null ? ` at age ${age}` : ""}`;
        break;
      }
      case "buy_home":
        description = `Buy a home for $${event.purchasePrice.toLocaleString()}${
          event.mortgage ? " (financed)" : " (cash)"
        }`;
        break;
      case "have_a_kid":
        description = `New dependent — childcare $${event.childcareMonthlyExpense.toLocaleString()}/mo`;
        break;
      case "custom_transfer":
        description = `Transfer $${event.amount.toLocaleString()}/${event.frequency} from ${accountName(
          event.fromAccountId
        )} to ${accountName(event.toAccountId)}`;
        break;
      case "growth_rate_change":
        description = `${accountName(event.targetAccountId)} growth rate changes to ${(event.newGrowthRatePct * 100).toFixed(1)}%`;
        break;
    }
    return {
      eventId: event.id,
      eventType: event.type,
      name: event.name,
      date: event.startDate,
      year: yearOf(event.startDate),
      description,
      isExcluded: event.isExcluded,
    };
  });
}
