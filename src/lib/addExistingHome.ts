import { accountObjectSchema, categoryForClass } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";

export interface ExistingHomeInput {
  homeValue: string;
  homeGrowthRatePct: string;
  propertyTaxRatePct: string;
  homeInsuranceRatePct: string;
  maintenanceRatePct: string;
  hasMortgage: boolean;
  mortgageBalance: string;
  mortgageRate: string;
  mortgageYearsLeft: string;
  mortgageExtraPrincipal: string;
}

export const EXISTING_HOME_DEFAULTS: ExistingHomeInput = {
  homeValue: "",
  homeGrowthRatePct: "0.03",
  propertyTaxRatePct: "",
  homeInsuranceRatePct: "",
  maintenanceRatePct: "",
  hasMortgage: false,
  mortgageBalance: "",
  mortgageRate: "0.065",
  mortgageYearsLeft: "25",
  mortgageExtraPrincipal: "",
};

/**
 * Shared by the Setup Wizard's "home you already own" step and the Accounts
 * tab's standalone version of the same flow -- creates a real_estate asset
 * account at its current value (no purchase transaction, since it's already
 * owned) plus an optional linked mortgage liability amortizing from today's
 * remaining balance. Always operates on whichever scenario is currently
 * active, same as every other addAccount/updateAccount call site.
 *
 * addAccount doesn't return the new id (the store generates it internally),
 * so -- same workaround the wizard used before this was extracted -- each
 * account is looked up right after insertion as "the last account in the
 * now-current scenario", which addAccount's append-only reducer guarantees.
 */
export function addExistingHome(
  input: ExistingHomeInput,
  planStartDate: string
): { ok: true } | { ok: false; error: string } {
  const value = Number(input.homeValue);
  if (!value || value <= 0) {
    return { ok: false, error: "Enter the home's estimated value." };
  }

  const { addAccount, updateAccount } = usePlanStore.getState();

  const realEstateCandidate = {
    name: "Home",
    class: "real_estate" as const,
    category: categoryForClass("real_estate"),
    ownerId: null,
    startingBalance: value,
    growthRatePct: Number(input.homeGrowthRatePct) || 0,
    propertyGrowthRatePct: Number(input.homeGrowthRatePct) || 0,
    taxTreatment: "n/a" as const,
    subjectToRMD: false,
    propertyTaxRatePct: input.propertyTaxRatePct.trim() !== "" ? Number(input.propertyTaxRatePct) : undefined,
    homeInsuranceRatePct: input.homeInsuranceRatePct.trim() !== "" ? Number(input.homeInsuranceRatePct) : undefined,
    maintenanceRatePct: input.maintenanceRatePct.trim() !== "" ? Number(input.maintenanceRatePct) : undefined,
  };
  const reResult = accountObjectSchema.omit({ id: true }).safeParse(realEstateCandidate);
  if (!reResult.success) {
    return { ok: false, error: reResult.error.issues[0]?.message ?? "That doesn't look right." };
  }
  addAccount(reResult.data);
  const afterRE = usePlanStore.getState().activeScenario();
  const realEstateAccount = afterRE.accounts[afterRE.accounts.length - 1];
  if (!realEstateAccount) {
    return { ok: false, error: "Something went wrong adding the home." };
  }

  if (input.hasMortgage) {
    const balance = Number(input.mortgageBalance);
    const rate = Number(input.mortgageRate);
    const years = Number(input.mortgageYearsLeft);
    if (!balance || balance <= 0 || !years || years <= 0) {
      return { ok: false, error: "Enter the mortgage's remaining balance and years left." };
    }
    const mortgageCandidate = {
      name: "Mortgage",
      class: "mortgage" as const,
      category: categoryForClass("mortgage"),
      ownerId: null,
      startingBalance: balance,
      growthRatePct: 0,
      taxTreatment: "n/a" as const,
      subjectToRMD: false,
      loanTerms: {
        originalPrincipal: balance,
        originationDate: planStartDate,
        annualInterestRatePct: rate,
        termMonths: Math.round(years * 12),
        extraPrincipalMonthly:
          input.mortgageExtraPrincipal.trim() !== "" ? Number(input.mortgageExtraPrincipal) : undefined,
        linkedAssetId: realEstateAccount.id,
      },
    };
    const mResult = accountObjectSchema.omit({ id: true }).safeParse(mortgageCandidate);
    if (!mResult.success) {
      return { ok: false, error: mResult.error.issues[0]?.message ?? "That doesn't look right." };
    }
    addAccount(mResult.data);
    const afterM = usePlanStore.getState().activeScenario();
    const mortgageAccount = afterM.accounts[afterM.accounts.length - 1];
    if (mortgageAccount) {
      updateAccount(realEstateAccount.id, { ...realEstateAccount, linkedLiabilityId: mortgageAccount.id });
    }
  }

  return { ok: true };
}

/**
 * Edits an existing-home account (one added via addExistingHome above, with
 * no linked buy_home event) in place -- name is always "Home", matching
 * addExistingHome's own convention. Creates, updates, or removes its linked
 * mortgage as the "still have a mortgage" toggle and fields change.
 */
export function updateExistingHome(
  accountId: string,
  input: ExistingHomeInput,
  planStartDate: string
): { ok: true } | { ok: false; error: string } {
  const value = Number(input.homeValue);
  if (!value || value <= 0) {
    return { ok: false, error: "Enter the home's estimated value." };
  }

  const { activeScenario, addAccount, updateAccount, removeAccount } = usePlanStore.getState();
  const scenario = activeScenario();
  const realEstateAccount = scenario.accounts.find((a) => a.id === accountId);
  if (!realEstateAccount) return { ok: false, error: "This home no longer exists." };
  const existingMortgage = realEstateAccount.linkedLiabilityId
    ? scenario.accounts.find((a) => a.id === realEstateAccount.linkedLiabilityId)
    : undefined;

  let linkedLiabilityId = realEstateAccount.linkedLiabilityId;

  if (input.hasMortgage) {
    const balance = Number(input.mortgageBalance);
    const rate = Number(input.mortgageRate);
    const years = Number(input.mortgageYearsLeft);
    if (!balance || balance <= 0 || !years || years <= 0) {
      return { ok: false, error: "Enter the mortgage's remaining balance and years left." };
    }
    const mortgageCandidate = {
      name: existingMortgage?.name ?? "Mortgage",
      class: "mortgage" as const,
      category: categoryForClass("mortgage"),
      ownerId: null,
      startingBalance: balance,
      growthRatePct: 0,
      taxTreatment: "n/a" as const,
      subjectToRMD: false,
      loanTerms: {
        originalPrincipal: balance,
        originationDate: existingMortgage?.loanTerms?.originationDate ?? planStartDate,
        annualInterestRatePct: rate,
        termMonths: Math.round(years * 12),
        extraPrincipalMonthly:
          input.mortgageExtraPrincipal.trim() !== "" ? Number(input.mortgageExtraPrincipal) : undefined,
        linkedAssetId: accountId,
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
    // No longer financed -- drop the now-unwanted mortgage if nothing else
    // references it (removeAccount refuses and reports false otherwise).
    if (!removeAccount(existingMortgage.id)) {
      return { ok: false, error: "Can't remove the mortgage -- it's still referenced elsewhere." };
    }
    linkedLiabilityId = undefined;
  }

  const realEstateCandidate = {
    name: realEstateAccount.name,
    class: "real_estate" as const,
    category: categoryForClass("real_estate"),
    ownerId: realEstateAccount.ownerId,
    startingBalance: value,
    growthRatePct: Number(input.homeGrowthRatePct) || 0,
    propertyGrowthRatePct: Number(input.homeGrowthRatePct) || 0,
    taxTreatment: realEstateAccount.taxTreatment,
    subjectToRMD: false,
    isExcluded: realEstateAccount.isExcluded,
    linkedLiabilityId,
    propertyTaxRatePct: input.propertyTaxRatePct.trim() !== "" ? Number(input.propertyTaxRatePct) : undefined,
    homeInsuranceRatePct: input.homeInsuranceRatePct.trim() !== "" ? Number(input.homeInsuranceRatePct) : undefined,
    maintenanceRatePct: input.maintenanceRatePct.trim() !== "" ? Number(input.maintenanceRatePct) : undefined,
  };
  const reResult = accountObjectSchema.omit({ id: true }).safeParse(realEstateCandidate);
  if (!reResult.success) return { ok: false, error: reResult.error.issues[0]?.message ?? "That doesn't look right." };
  updateAccount(accountId, reResult.data);
  return { ok: true };
}

/** Removes an existing-home account and its linked mortgage, if any. Fails
 *  (without removing anything) if either is still referenced elsewhere --
 *  e.g. a sell_home event that hasn't been deleted first. */
export function removeExistingHome(accountId: string): { ok: true } | { ok: false; error: string } {
  const { activeScenario, removeAccount } = usePlanStore.getState();
  const scenario = activeScenario();
  const account = scenario.accounts.find((a) => a.id === accountId);
  if (account?.linkedLiabilityId) {
    if (!removeAccount(account.linkedLiabilityId)) {
      return { ok: false, error: "Can't delete this home -- its mortgage is still referenced elsewhere." };
    }
  }
  if (!removeAccount(accountId)) {
    return {
      ok: false,
      error: "Can't delete this home -- it's still referenced elsewhere (e.g. a Sell a Home event). Remove that first.",
    };
  }
  return { ok: true };
}
