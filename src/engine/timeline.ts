import type { Scenario, ScenarioEvent, TimelineRow } from "@/domain";
import { ageOn, elapsedYears, yearOf } from "./dateMath";
import { freqLabel } from "@/lib/timelineFormat";

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
        const expense = event.retirementExpense
          ? ` · $${event.retirementExpense.amount.toLocaleString()}/yr expense`
          : "";
        description = `${personName(event.personId)} retires${age !== null ? ` at age ${age}` : ""}${expense}`;
        break;
      }
      case "buy_home": {
        const financing = event.mortgage
          ? ` financed over ${Math.round(event.mortgage.termMonths / 12)} yrs at ${(
              event.mortgage.annualInterestRatePct * 100
            ).toFixed(2)}%`
          : " paid in cash";
        description = `Buy a home for $${event.purchasePrice.toLocaleString()},${financing}`;
        break;
      }
      case "have_a_kid": {
        const end = event.childcareEndDate;
        const duration = end
          ? `for ${Math.round(elapsedYears(event.startDate, end))} yrs (through ${yearOf(end)})`
          : "through end of plan";
        const oneTime = event.additionalOneTimeCost
          ? ` · $${event.additionalOneTimeCost.toLocaleString()} upfront`
          : "";
        description = `Childcare $${event.childcareMonthlyExpense.toLocaleString()}/mo ${duration}${oneTime}`;
        break;
      }
      case "custom_transfer": {
        const freq = freqLabel(event.frequency, event.intervalYears);
        const until = event.endDate ? ` until ${yearOf(event.endDate)}` : "";
        description = `Transfer $${event.amount.toLocaleString()}${freq} from ${accountName(
          event.fromAccountId
        )} to ${accountName(event.toAccountId)}${until}`;
        break;
      }
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
