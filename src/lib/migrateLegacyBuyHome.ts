import { nanoid } from "nanoid";
import { elapsedYears } from "@/engine/dateMath";
import { growthAdjustedAmount } from "@/engine/growth";

/**
 * A buy_home event used to carry its home's full details inline
 * (propertyGrowthRatePct, mortgage, propertyTaxRatePct, homeInsuranceRatePct,
 * maintenanceRatePct) and the engine synthesized an ephemeral, non-editable
 * account from them on every calculation. That home is now a real, permanent
 * Account -- editable on the Account tab and sellable via sell_home, exactly
 * like one added via "Add a Home You Already Own" -- and the event only
 * records the purchase transaction (see BuyHomeEvent.realEstateAccountId in
 * src/domain/events.ts).
 *
 * This operates on loosely-typed JSON, before Zod validation, the same way
 * migrateV2Plan.ts does -- the new buyHomeEventSchema requires
 * realEstateAccountId, so an old-shape event would otherwise fail validation
 * outright before scenarioSchema's own additive auto-migrate transform ever
 * got a chance to run. Whatever this produces is re-validated by planSchema
 * immediately after by the caller, so a malformed migration fails loudly
 * rather than silently corrupting data.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function isRecord(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isLegacyBuyHomeEvent(e: Json): boolean {
  return isRecord(e) && e.type === "buy_home" && typeof e.realEstateAccountId !== "string";
}

/** True if `raw` has any buy_home event in the old (pre-unification) shape. */
export function looksLikeLegacyBuyHomePlan(raw: unknown): boolean {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) return false;
  return raw.scenarios.some(
    (s: Json) => isRecord(s) && Array.isArray(s.events) && s.events.some(isLegacyBuyHomeEvent)
  );
}

function migrateScenario(scenario: Json): Json {
  const events: Json[] = scenario.events ?? [];
  if (!events.some(isLegacyBuyHomeEvent)) return scenario;

  const planStartDate: string = scenario.settings?.startDate;
  const inflationRatePct: number = scenario.settings?.inflationRatePct ?? 0;
  const newAccounts: Json[] = [];

  const migratedEvents = events.map((event) => {
    if (!isLegacyBuyHomeEvent(event)) return event;

    // Same two-stage math the engine used to apply on every render (today's
    // dollars -> nominal at the purchase date) -- computed once here instead,
    // and baked into the new account's startingBalance.
    const years = elapsedYears(planStartDate, event.startDate);
    const purchasePrice = Number(event.purchasePrice) || 0;
    const downPaymentAmount = Number(event.downPaymentAmount) || 0;
    const nominalPrice = growthAdjustedAmount(purchasePrice, years, inflationRatePct);
    const nominalDown = growthAdjustedAmount(downPaymentAmount, years, inflationRatePct);

    const realEstateId = nanoid();
    let linkedLiabilityId: string | undefined;

    if (event.mortgage) {
      const mortgageId = nanoid();
      const principal = Math.max(0, nominalPrice - nominalDown);
      newAccounts.push({
        id: mortgageId,
        name: `${event.name} (Mortgage)`,
        class: "mortgage",
        category: "liability",
        ownerId: null,
        startingBalance: principal,
        growthRatePct: 0,
        taxTreatment: "n/a",
        subjectToRMD: false,
        startDate: event.startDate,
        loanTerms: {
          originalPrincipal: principal,
          originationDate: event.startDate,
          annualInterestRatePct: event.mortgage.annualInterestRatePct,
          termMonths: event.mortgage.termMonths,
          extraPrincipalMonthly: event.mortgage.extraPrincipalMonthly,
          linkedAssetId: realEstateId,
        },
      });
      linkedLiabilityId = mortgageId;
    }

    newAccounts.push({
      id: realEstateId,
      name: event.name,
      class: "real_estate",
      category: "asset",
      ownerId: null,
      startingBalance: nominalPrice,
      growthRatePct: event.propertyGrowthRatePct ?? 0,
      propertyGrowthRatePct: event.propertyGrowthRatePct ?? 0,
      taxTreatment: "n/a",
      subjectToRMD: false,
      startDate: event.startDate,
      linkedLiabilityId,
      propertyTaxRatePct: event.propertyTaxRatePct,
      homeInsuranceRatePct: event.homeInsuranceRatePct,
      maintenanceRatePct: event.maintenanceRatePct,
    });

    return {
      id: event.id,
      type: "buy_home",
      name: event.name,
      startDate: event.startDate,
      endDate: event.endDate,
      notes: event.notes,
      isExcluded: event.isExcluded,
      purchasePrice: event.purchasePrice,
      downPaymentAmount: event.downPaymentAmount,
      downPaymentFromAccountId: event.downPaymentFromAccountId,
      realEstateAccountId: realEstateId,
      replaceHousingExpenses: event.replaceHousingExpenses,
    };
  });

  return {
    ...scenario,
    accounts: [...(scenario.accounts ?? []), ...newAccounts],
    events: migratedEvents,
  };
}

export function migrateLegacyBuyHomeEvents(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.scenarios)) return raw;
  return { ...raw, scenarios: raw.scenarios.map(migrateScenario) };
}
