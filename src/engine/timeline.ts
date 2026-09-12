import type { Scenario, ScenarioEvent, TimelineRow } from "@/domain";
import { ageOn, yearOf } from "./dateMath";
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
        // Rates/mortgage terms now live on the linked real_estate account
        // (and its own linked mortgage account) -- see BuyHomeEvent.realEstateAccountId.
        const home = scenario.accounts.find((a) => a.id === event.realEstateAccountId);
        const mortgage = home?.linkedLiabilityId
          ? scenario.accounts.find((a) => a.id === home.linkedLiabilityId)
          : undefined;
        const financing = mortgage?.loanTerms
          ? ` financed over ${Math.round(mortgage.loanTerms.termMonths / 12)} yrs at ${(
              mortgage.loanTerms.annualInterestRatePct * 100
            ).toFixed(2)}%`
          : " paid in cash";
        description = `Buy a home for $${event.purchasePrice.toLocaleString()},${financing}`;
        break;
      }
      case "sell_home": {
        // In estimate mode the engine ignores netProceeds, so the row must not quote it.
        description =
          event.sellingCostsPct != null
            ? `Sell ${accountName(event.realEstateAccountId)} (proceeds estimated after ${Math.round(event.sellingCostsPct * 100)}% selling costs and the mortgage payoff)`
            : `Sell ${accountName(event.realEstateAccountId)} for a net $${event.netProceeds.toLocaleString()}`;
        break;
      }
      case "roth_conversion": {
        const how =
          event.fillToBracketRate != null
            ? `up to the top of the ${Math.round(event.fillToBracketRate * 100)}% bracket each year`
            : `$${(event.amount ?? 0).toLocaleString()}${event.frequency === "one_time" ? " once" : "/yr"}`;
        const until = event.endDate ? ` until ${yearOf(event.endDate)}` : "";
        description = `Convert ${how} from ${accountName(event.fromAccountId)} to ${accountName(event.toAccountId)}${until}${
          event.taxSource === "withhold" ? " (tax withheld from the conversion)" : " (tax paid from cash)"
        }`;
        break;
      }
      case "pay_off_loan": {
        description = `Pay ${event.amount == null ? "off" : `$${event.amount.toLocaleString()} toward`} ${accountName(event.loanAccountId)} from ${accountName(event.fromAccountId)}`;
        break;
      }
      case "rollover": {
        description = `Roll ${event.amount == null ? "the whole balance" : `$${event.amount.toLocaleString()}`} from ${accountName(event.fromAccountId)} into ${accountName(event.toAccountId)}`;
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
