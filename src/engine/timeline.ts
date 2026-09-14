import type { Scenario, ScenarioEvent, TimelineRow } from "@/domain";
import { retirementsInOrder } from "@/domain";
import { ageOn, yearOf } from "./dateMath";
import { freqLabel } from "@/lib/timelineFormat";

export function buildTimeline(scenario: Scenario): TimelineRow[] {
  const accountName = (id: string) =>
    scenario.accounts.find((a) => a.id === id)?.name ?? "an account";

  const eventRows = scenario.events.map((event: ScenarioEvent) => {
    let description: string;
    switch (event.type) {
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
      case "open_loan": {
        const where =
          event.proceedsAccountId == null
            ? "paid for something outside the plan"
            : `deposited into ${accountName(event.proceedsAccountId)}`;
        description = `Borrow $${event.principal.toLocaleString()} as ${accountName(event.loanAccountId)}, ${where}`;
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

  // Retirement is a property of a person, not an event, so its rows are built
  // from the household -- one per person who retires, with the same shape as
  // an event row so every consumer (the Timeline tab, the chart's milestones)
  // keeps treating them alike.
  const retirementRows: TimelineRow[] = retirementsInOrder(scenario.household.people).map(({ person, date }) => {
    const spending = person.retirementSpending?.amount
      ? ` · $${person.retirementSpending.amount.toLocaleString()}/yr extra spending`
      : "";
    return {
      eventId: `retirement:${person.id}`,
      eventType: "retirement" as const,
      name: `${person.name} retires`,
      date,
      year: yearOf(date),
      description: `${person.name} retires at age ${ageOn(person.birthDate, date)}${spending}. Their salary and paycheck contributions stop here.`,
    };
  });

  return [...eventRows, ...retirementRows].sort((a, b) => a.date.localeCompare(b.date));
}
