import { accountObjectSchema, buyHomeEventSchema, categoryForClass } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { elapsedYears } from "@/engine/dateMath";
import { growthAdjustedAmount } from "@/engine/growth";

export interface BuyHomeInput {
  name: string;
  startDate: string;
  purchasePrice: string;
  financed: boolean;
  downPaymentAmount: string;
  downPaymentFromAccountId: string;
  mortgageRate: string;
  mortgageTermYears: string;
  mortgageExtraPrincipal: string;
  propertyGrowthRatePct: string;
  propertyTaxRatePct: string;
  homeInsuranceRatePct: string;
  maintenanceRatePct: string;
  replaceHousingExpenses: boolean;
}

export const BUY_HOME_DEFAULTS: BuyHomeInput = {
  name: "",
  startDate: "",
  purchasePrice: "",
  financed: true,
  downPaymentAmount: "",
  downPaymentFromAccountId: "",
  mortgageRate: "0.06",
  mortgageTermYears: "30",
  mortgageExtraPrincipal: "",
  propertyGrowthRatePct: "0.03",
  propertyTaxRatePct: "0.01",
  homeInsuranceRatePct: "0.005",
  maintenanceRatePct: "0.01",
  replaceHousingExpenses: false,
};

type Result = { ok: true } | { ok: false; error: string };

/**
 * Today's-dollars amount -> nominal dollars at the closing date, same
 * inflate-then-its-own-rate-takes-over two-stage pattern used everywhere
 * else in this app (see todaysDollarsAmount) -- computed once here and baked
 * into the account's startingBalance as a snapshot, rather than recomputed on
 * every render the way an ephemeral buy_home account used to be. If the
 * plan's inflation assumption changes later, re-saving this home (either
 * from here or the Account tab) refreshes it.
 */
function nominalAt(amountToday: number, planStartDate: string, closingDate: string, inflationRatePct: number): number {
  return growthAdjustedAmount(amountToday, elapsedYears(planStartDate, closingDate), inflationRatePct);
}

function validate(input: BuyHomeInput): string | null {
  if (!input.name.trim()) return "Give this purchase a name.";
  if (!input.startDate) return "Enter a purchase (closing) date.";
  if (!(Number(input.purchasePrice) > 0)) return "Enter the purchase price.";
  if (!input.downPaymentFromAccountId) return "Choose which account pays for this.";
  return null;
}

/** Creates a real_estate account (and, if financed, its linked mortgage
 *  account) plus the thin buy_home event that references it -- the home is a
 *  real, permanent Account from this point on, exactly like one added via
 *  "Add a Home You Already Own" (editable on the Account tab, sellable via a
 *  later Sell a Home event). */
export function buyNewHome(input: BuyHomeInput, settings: { startDate: string; inflationRatePct: number }): Result {
  const error = validate(input);
  if (error) return { ok: false, error };

  const name = input.name.trim();
  const purchasePrice = Number(input.purchasePrice);
  const downPaymentAmount = input.financed ? Number(input.downPaymentAmount) || 0 : purchasePrice;
  const nominalPrice = nominalAt(purchasePrice, settings.startDate, input.startDate, settings.inflationRatePct);
  const nominalDown = nominalAt(downPaymentAmount, settings.startDate, input.startDate, settings.inflationRatePct);
  const propertyGrowthRatePct = Number(input.propertyGrowthRatePct) || 0;

  const { addAccount, addEvent } = usePlanStore.getState();

  const realEstateCandidate = {
    name,
    class: "real_estate" as const,
    category: categoryForClass("real_estate"),
    ownerId: null,
    startingBalance: nominalPrice,
    growthRatePct: propertyGrowthRatePct,
    propertyGrowthRatePct,
    taxTreatment: "n/a" as const,
    subjectToRMD: false,
    startDate: input.startDate,
    propertyTaxRatePct: input.propertyTaxRatePct.trim() !== "" ? Number(input.propertyTaxRatePct) : undefined,
    homeInsuranceRatePct: input.homeInsuranceRatePct.trim() !== "" ? Number(input.homeInsuranceRatePct) : undefined,
    maintenanceRatePct: input.maintenanceRatePct.trim() !== "" ? Number(input.maintenanceRatePct) : undefined,
  };
  const reResult = accountObjectSchema.omit({ id: true }).safeParse(realEstateCandidate);
  if (!reResult.success) return { ok: false, error: reResult.error.issues[0]?.message ?? "That doesn't look right." };
  addAccount(reResult.data);
  const afterRE = usePlanStore.getState().activeScenario();
  const realEstateAccount = afterRE.accounts[afterRE.accounts.length - 1];
  if (!realEstateAccount) return { ok: false, error: "Something went wrong adding the home." };

  if (input.financed) {
    const rate = Number(input.mortgageRate) || 0;
    const termMonths = Math.max(1, Math.round(Number(input.mortgageTermYears) || 0) * 12);
    const principal = Math.max(0, nominalPrice - nominalDown);
    const mortgageCandidate = {
      name: `${name} (Mortgage)`,
      class: "mortgage" as const,
      category: categoryForClass("mortgage"),
      ownerId: null,
      startingBalance: principal,
      growthRatePct: 0,
      taxTreatment: "n/a" as const,
      subjectToRMD: false,
      startDate: input.startDate,
      loanTerms: {
        originalPrincipal: principal,
        originationDate: input.startDate,
        annualInterestRatePct: rate,
        termMonths,
        extraPrincipalMonthly:
          input.mortgageExtraPrincipal.trim() !== "" ? Number(input.mortgageExtraPrincipal) : undefined,
        linkedAssetId: realEstateAccount.id,
      },
    };
    const mResult = accountObjectSchema.omit({ id: true }).safeParse(mortgageCandidate);
    if (!mResult.success) return { ok: false, error: mResult.error.issues[0]?.message ?? "That doesn't look right." };
    addAccount(mResult.data);
    const afterM = usePlanStore.getState().activeScenario();
    const mortgageAccount = afterM.accounts[afterM.accounts.length - 1];
    if (mortgageAccount) {
      usePlanStore.getState().updateAccount(realEstateAccount.id, { ...realEstateAccount, linkedLiabilityId: mortgageAccount.id });
    }
  }

  const eventCandidate = {
    type: "buy_home" as const,
    name,
    startDate: input.startDate,
    purchasePrice,
    downPaymentAmount,
    downPaymentFromAccountId: input.downPaymentFromAccountId,
    realEstateAccountId: realEstateAccount.id,
    replaceHousingExpenses: input.replaceHousingExpenses,
  };
  const eResult = buyHomeEventSchema.omit({ id: true }).safeParse(eventCandidate);
  if (!eResult.success) return { ok: false, error: eResult.error.issues[0]?.message ?? "That doesn't look right." };
  addEvent(eResult.data);
  return { ok: true };
}

/** Edits an existing buy_home purchase in place -- updates its linked
 *  real_estate account (and creates, updates, or removes its mortgage
 *  account as the financed toggle/fields change) together with the event
 *  itself, so the event and the account never disagree. */
export function updateBoughtHome(
  eventId: string,
  input: BuyHomeInput,
  settings: { startDate: string; inflationRatePct: number }
): Result {
  const error = validate(input);
  if (error) return { ok: false, error };

  const { activeScenario, addAccount, updateAccount, updateEvent, removeAccount } = usePlanStore.getState();
  const scenario = activeScenario();
  const event = scenario.events.find((e) => e.id === eventId);
  if (!event || event.type !== "buy_home") return { ok: false, error: "That purchase no longer exists." };
  const realEstateAccount = scenario.accounts.find((a) => a.id === event.realEstateAccountId);
  if (!realEstateAccount) return { ok: false, error: "This purchase's home account is missing." };

  const name = input.name.trim();
  const purchasePrice = Number(input.purchasePrice);
  const downPaymentAmount = input.financed ? Number(input.downPaymentAmount) || 0 : purchasePrice;
  const nominalPrice = nominalAt(purchasePrice, settings.startDate, input.startDate, settings.inflationRatePct);
  const nominalDown = nominalAt(downPaymentAmount, settings.startDate, input.startDate, settings.inflationRatePct);
  const propertyGrowthRatePct = Number(input.propertyGrowthRatePct) || 0;

  let linkedLiabilityId = realEstateAccount.linkedLiabilityId;
  const existingMortgage = linkedLiabilityId ? scenario.accounts.find((a) => a.id === linkedLiabilityId) : undefined;

  if (input.financed) {
    const rate = Number(input.mortgageRate) || 0;
    const termMonths = Math.max(1, Math.round(Number(input.mortgageTermYears) || 0) * 12);
    const principal = Math.max(0, nominalPrice - nominalDown);
    const mortgageCandidate = {
      name: existingMortgage?.name ?? `${name} (Mortgage)`,
      class: "mortgage" as const,
      category: categoryForClass("mortgage"),
      ownerId: null,
      startingBalance: principal,
      growthRatePct: 0,
      taxTreatment: "n/a" as const,
      subjectToRMD: false,
      startDate: input.startDate,
      loanTerms: {
        originalPrincipal: principal,
        originationDate: input.startDate,
        annualInterestRatePct: rate,
        termMonths,
        extraPrincipalMonthly:
          input.mortgageExtraPrincipal.trim() !== "" ? Number(input.mortgageExtraPrincipal) : undefined,
        linkedAssetId: realEstateAccount.id,
      },
    };
    const mResult = accountObjectSchema.omit({ id: true }).safeParse(mortgageCandidate);
    if (!mResult.success) return { ok: false, error: mResult.error.issues[0]?.message ?? "That doesn't look right." };
    if (existingMortgage) {
      updateAccount(existingMortgage.id, mResult.data);
    } else {
      addAccount(mResult.data);
      const after = usePlanStore.getState().activeScenario();
      linkedLiabilityId = after.accounts[after.accounts.length - 1]?.id;
    }
  } else if (existingMortgage) {
    if (!removeAccount(existingMortgage.id)) {
      return { ok: false, error: "Can't switch to cash -- the mortgage is still referenced elsewhere." };
    }
    linkedLiabilityId = undefined;
  }

  const realEstateCandidate = {
    name,
    class: "real_estate" as const,
    category: categoryForClass("real_estate"),
    ownerId: realEstateAccount.ownerId,
    startingBalance: nominalPrice,
    growthRatePct: propertyGrowthRatePct,
    propertyGrowthRatePct,
    taxTreatment: realEstateAccount.taxTreatment,
    subjectToRMD: false,
    startDate: input.startDate,
    isExcluded: realEstateAccount.isExcluded,
    linkedLiabilityId,
    propertyTaxRatePct: input.propertyTaxRatePct.trim() !== "" ? Number(input.propertyTaxRatePct) : undefined,
    homeInsuranceRatePct: input.homeInsuranceRatePct.trim() !== "" ? Number(input.homeInsuranceRatePct) : undefined,
    maintenanceRatePct: input.maintenanceRatePct.trim() !== "" ? Number(input.maintenanceRatePct) : undefined,
  };
  const reResult = accountObjectSchema.omit({ id: true }).safeParse(realEstateCandidate);
  if (!reResult.success) return { ok: false, error: reResult.error.issues[0]?.message ?? "That doesn't look right." };
  updateAccount(realEstateAccount.id, reResult.data);

  const eventCandidate = {
    type: "buy_home" as const,
    name,
    startDate: input.startDate,
    purchasePrice,
    downPaymentAmount,
    downPaymentFromAccountId: input.downPaymentFromAccountId,
    realEstateAccountId: realEstateAccount.id,
    replaceHousingExpenses: input.replaceHousingExpenses,
  };
  const eResult = buyHomeEventSchema.omit({ id: true }).safeParse(eventCandidate);
  if (!eResult.success) return { ok: false, error: eResult.error.issues[0]?.message ?? "That doesn't look right." };
  updateEvent(eventId, eResult.data);
  return { ok: true };
}

/** Removes a buy_home event and cascades to its linked real_estate account
 *  and mortgage, since they only ever existed for this purchase. Fails
 *  (without removing anything) if the home is still referenced elsewhere --
 *  e.g. a Sell a Home event that hasn't been deleted first. */
export function removeBoughtHome(eventId: string): Result {
  const { activeScenario, removeAccount, removeEvent } = usePlanStore.getState();
  const scenario = activeScenario();
  const event = scenario.events.find((e) => e.id === eventId);
  if (!event || event.type !== "buy_home") return { ok: false, error: "That purchase no longer exists." };
  const realEstateAccount = scenario.accounts.find((a) => a.id === event.realEstateAccountId);

  if (realEstateAccount?.linkedLiabilityId) {
    if (!removeAccount(realEstateAccount.linkedLiabilityId)) {
      return { ok: false, error: "Can't delete this home -- its mortgage is still referenced elsewhere." };
    }
  }
  if (realEstateAccount) {
    if (!removeAccount(realEstateAccount.id)) {
      return {
        ok: false,
        error: "Can't delete this home -- it's still referenced elsewhere (e.g. a Sell a Home event). Remove that first.",
      };
    }
  }
  removeEvent(eventId);
  return { ok: true };
}
