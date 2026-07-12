import type { ISODate, Person } from "@/domain";
import { ageOn, endOfYear } from "./dateMath";

export type FilingStatus = "single" | "marriedFilingJointly";

/** Upper bound of taxable income for this bracket; null = no upper bound (top bracket). */
export interface TaxBracket {
  upTo: number | null;
  rate: number;
}

/**
 * 2026 federal tax law (IRS Rev. Proc. 2025-32, incl. One Big Beautiful Bill
 * Act amendments). Update this block -- not the calculator functions below
 * it -- when a new tax year's numbers are published. Values are nominal
 * 2026 dollars; `bracketsForYear`/`standardDeductionForYear` project them
 * forward for later years using the plan's inflation assumption.
 */
export const TAX_TABLES_2026 = {
  baseYear: 2026,
  ordinaryBrackets: {
    single: [
      { upTo: 12_400, rate: 0.1 },
      { upTo: 50_400, rate: 0.12 },
      { upTo: 105_700, rate: 0.22 },
      { upTo: 201_775, rate: 0.24 },
      { upTo: 256_225, rate: 0.32 },
      { upTo: 640_600, rate: 0.35 },
      { upTo: null, rate: 0.37 },
    ] as TaxBracket[],
    marriedFilingJointly: [
      { upTo: 24_800, rate: 0.1 },
      { upTo: 100_800, rate: 0.12 },
      { upTo: 211_400, rate: 0.22 },
      { upTo: 403_550, rate: 0.24 },
      { upTo: 512_450, rate: 0.32 },
      { upTo: 768_700, rate: 0.35 },
      { upTo: null, rate: 0.37 },
    ] as TaxBracket[],
  },
  /** Long-term capital gains brackets -- stack on top of ordinary income. */
  ltcgBrackets: {
    single: [
      { upTo: 49_450, rate: 0 },
      { upTo: 545_500, rate: 0.15 },
      { upTo: null, rate: 0.2 },
    ] as TaxBracket[],
    marriedFilingJointly: [
      { upTo: 98_900, rate: 0 },
      { upTo: 613_700, rate: 0.15 },
      { upTo: null, rate: 0.2 },
    ] as TaxBracket[],
  },
  standardDeduction: {
    single: 16_100,
    marriedFilingJointly: 32_200,
  },
  /** IRC §63(f) additional standard deduction, per qualifying person age 65+. */
  age65AdditionalDeduction: {
    single: 2_050,
    marriedFilingJointly: 1_650,
  },
  /**
   * Temporary OBBBA "senior deduction" (tax years 2025-2028), per person
   * age 65+, on top of the §63(f) bump above. Phases out 6 cents per dollar
   * of income over the threshold.
   */
  seniorDeduction: {
    perPerson: 6_000,
    phaseOutStart: { single: 75_000, marriedFilingJointly: 150_000 },
    phaseOutRate: 0.06,
  },
  /**
   * Provisional-income thresholds for Social Security taxability. NOT
   * inflation-indexed by law (fixed in nominal dollars since 1984/1993) --
   * `bracketsForYear` deliberately does not project these forward.
   */
  socialSecurityThresholds: {
    single: { base: 25_000, additional: 34_000 },
    marriedFilingJointly: { base: 32_000, additional: 44_000 },
  },
};

function inflationFactor(year: number, inflationRatePct: number): number {
  return Math.pow(1 + inflationRatePct, year - TAX_TABLES_2026.baseYear);
}

function inflateBrackets(brackets: TaxBracket[], factor: number): TaxBracket[] {
  return brackets.map((b) => ({ ...b, upTo: b.upTo == null ? null : b.upTo * factor }));
}

/** This year's ordinary + LTCG brackets, inflated forward from the 2026 base. */
export function bracketsForYear(
  year: number,
  filingStatus: FilingStatus,
  inflationRatePct: number
): { ordinary: TaxBracket[]; ltcg: TaxBracket[] } {
  const factor = inflationFactor(year, inflationRatePct);
  return {
    ordinary: inflateBrackets(TAX_TABLES_2026.ordinaryBrackets[filingStatus], factor),
    ltcg: inflateBrackets(TAX_TABLES_2026.ltcgBrackets[filingStatus], factor),
  };
}

/** Standard progressive-bracket tax on taxable income (already net of deductions). */
export function progressiveTax(taxableIncome: number, brackets: TaxBracket[]): number {
  if (taxableIncome <= 0) return 0;
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo ?? Infinity;
    if (taxableIncome <= lower) break;
    tax += (Math.min(taxableIncome, upper) - lower) * b.rate;
    lower = upper;
  }
  return tax;
}

/** The rate that would apply to the next dollar of taxable income. */
export function marginalRate(taxableIncome: number, brackets: TaxBracket[]): number {
  const income = Math.max(0, taxableIncome);
  for (const b of brackets) {
    if (b.upTo == null || income <= b.upTo) return b.rate;
  }
  return brackets[brackets.length - 1]?.rate ?? 0;
}

/**
 * Long-term capital gains stack on top of ordinary taxable income (real IRS
 * stacking rule): the band of (ordinaryTaxableIncome, ordinaryTaxableIncome +
 * netGains] that falls in each LTCG bracket is taxed at that bracket's rate.
 */
export function stackedLtcgTax(
  ordinaryTaxableIncome: number,
  netGains: number,
  ltcgBrackets: TaxBracket[]
): { tax: number; marginalRate: number } {
  const base = Math.max(0, ordinaryTaxableIncome);
  if (netGains <= 0) return { tax: 0, marginalRate: marginalRate(base, ltcgBrackets) };
  const top = base + netGains;
  let tax = 0;
  let lower = 0;
  for (const b of ltcgBrackets) {
    const upper = b.upTo ?? Infinity;
    const bandLower = Math.max(lower, base);
    const bandUpper = Math.min(upper, top);
    if (bandUpper > bandLower) tax += (bandUpper - bandLower) * b.rate;
    lower = upper;
  }
  return { tax, marginalRate: marginalRate(top, ltcgBrackets) };
}

/**
 * Taxable portion of Social Security benefits, via the standard closed-form
 * equivalent of the IRS worksheet: compare provisional income (other
 * ordinary income + half the benefit) against the base/additional
 * thresholds and apply the 0%/50%/85% inclusion tiers.
 */
export function taxableSocialSecurity(
  grossBenefits: number,
  otherOrdinaryIncome: number,
  filingStatus: FilingStatus
): number {
  if (grossBenefits <= 0) return 0;
  const { base, additional } = TAX_TABLES_2026.socialSecurityThresholds[filingStatus];
  const halfBenefits = grossBenefits / 2;
  const provisionalIncome = Math.max(0, otherOrdinaryIncome) + halfBenefits;
  if (provisionalIncome <= base) return 0;
  const tier1 = Math.min(provisionalIncome, additional) - base;
  const tier1Taxable = Math.min(0.5 * tier1, halfBenefits);
  if (provisionalIncome <= additional) return tier1Taxable;
  const tier2 = provisionalIncome - additional;
  return Math.min(0.85 * tier2 + tier1Taxable, 0.85 * grossBenefits);
}

/**
 * This year's standard deduction: base amount (inflated) + the §63(f) age-65
 * bump per qualifying person + the temporary OBBBA senior deduction (phases
 * out above the threshold, based on the year's other ordinary income as a
 * MAGI proxy).
 */
export function standardDeductionForYear(
  people: Pick<Person, "birthDate">[],
  filingStatus: FilingStatus,
  year: number,
  inflationRatePct: number,
  otherOrdinaryIncomeForPhaseOut: number
): number {
  const factor = inflationFactor(year, inflationRatePct);
  const yearEnd: ISODate = endOfYear(year);
  const seniors = people.filter((p) => ageOn(p.birthDate, yearEnd) >= 65).length;

  const base = TAX_TABLES_2026.standardDeduction[filingStatus] * factor;
  const age65Bump = seniors * TAX_TABLES_2026.age65AdditionalDeduction[filingStatus] * factor;

  const { perPerson, phaseOutStart, phaseOutRate } = TAX_TABLES_2026.seniorDeduction;
  const phaseStart = phaseOutStart[filingStatus] * factor;
  const excess = Math.max(0, otherOrdinaryIncomeForPhaseOut - phaseStart);
  const perPersonAfterPhaseOut = Math.max(0, perPerson * factor - excess * phaseOutRate);
  const seniorDeduction = seniors * perPersonAfterPhaseOut;

  return base + age65Bump + seniorDeduction;
}

/**
 * The engine's internal per-year tax-rate estimate, refined each convergence
 * iteration (see `projectScenario` in forecastScenario.ts) from the prior
 * pass's actual bracket math. Used only to size withdrawals/withholding
 * during the monthly simulation -- the reported tax figure is always the
 * exact bracket calculation, computed after the fact from realized income.
 */
export interface YearTaxRates {
  /** Marginal ordinary-income rate -- applied to tax-deferred withdrawals and SS/pension withholding. */
  ordinaryMarginalRate: number;
  /** Marginal LTCG rate -- applied to the realized-gain portion of taxable-account withdrawals. */
  ltcgMarginalRate: number;
  /** Estimated fraction of gross Social Security benefits that's taxable this year, for withholding sizing. */
  ssTaxableFraction: number;
}

export const ZERO_TAX_RATES: YearTaxRates = { ordinaryMarginalRate: 0, ltcgMarginalRate: 0, ssTaxableFraction: 0 };

export const SEED_TAX_RATES: YearTaxRates = { ordinaryMarginalRate: 0.12, ltcgMarginalRate: 0.15, ssTaxableFraction: 0.5 };
