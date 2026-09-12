import type { FilingStatus, HealthcareSettings, Id, ISODate, Person } from "@/domain";
import { ageOn, elapsedYears, yearOf } from "./dateMath";

/**
 * The healthcare model: what coverage costs a household month by month,
 * driven by the two places the real rules key off income -- the marketplace
 * premium tax credit before 65, and Medicare's income-related surcharges
 * (IRMAA) after. Pure functions over settings and a per-month context; the
 * engine turns the result into ordinary expense postings.
 *
 * Every table below is a 2026 figure. Update this block, not the functions,
 * when a new year's numbers are published.
 */
export const HEALTHCARE_TABLES_2026 = {
  baseYear: 2026,
  /** HHS poverty guidelines used for 2026 marketplace coverage (2025 guidelines, 48 states + DC). Indexed by general inflation. */
  povertyLine: { first: 15_650, perAdditional: 5_500 },
  /**
   * Premium tax credit: the share of income a household is expected to pay
   * for the benchmark plan, by income as a multiple of the poverty line,
   * linear within each band. Current law (IRC 36B as indexed for 2026):
   * nothing below the poverty line (Medicaid territory) or above four times it.
   */
  applicablePct: {
    currentLaw: [
      { from: 1.0, to: 1.33, pctFrom: 0.021, pctTo: 0.021 },
      { from: 1.33, to: 1.5, pctFrom: 0.0314, pctTo: 0.0419 },
      { from: 1.5, to: 2.0, pctFrom: 0.0419, pctTo: 0.066 },
      { from: 2.0, to: 2.5, pctFrom: 0.066, pctTo: 0.0844 },
      { from: 2.5, to: 3.0, pctFrom: 0.0844, pctTo: 0.0996 },
      { from: 3.0, to: 4.0, pctFrom: 0.0996, pctTo: 0.0996 },
    ],
    /** The 2021-2025 enhanced schedule: no cap at four times poverty, 8.5% ceiling. */
    enhanced: [
      { from: 1.0, to: 1.5, pctFrom: 0, pctTo: 0 },
      { from: 1.5, to: 2.0, pctFrom: 0, pctTo: 0.02 },
      { from: 2.0, to: 2.5, pctFrom: 0.02, pctTo: 0.04 },
      { from: 2.5, to: 3.0, pctFrom: 0.04, pctTo: 0.06 },
      { from: 3.0, to: 4.0, pctFrom: 0.06, pctTo: 0.085 },
    ],
    enhancedAboveCap: 0.085,
  },
  /**
   * The federal default age curve (45 CFR 147.102): a plan's premium for
   * each age relative to a 21-year-old's. Most states use it as-is.
   */
  ageCurve: [
    0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, 0.765, // 0-14
    0.833, 0.859, 0.885, 0.913, 0.941, 0.97, // 15-20
    1.0, 1.0, 1.0, 1.0, 1.004, 1.024, 1.048, 1.087, 1.119, 1.135, // 21-30
    1.159, 1.183, 1.198, 1.214, 1.222, 1.23, 1.238, 1.246, 1.262, 1.278, // 31-40
    1.302, 1.325, 1.357, 1.397, 1.444, 1.5, 1.563, 1.635, 1.706, 1.786, // 41-50
    1.865, 1.952, 2.04, 2.135, 2.23, 2.333, 2.437, 2.548, 2.603, 2.714, // 51-60
    2.81, 2.873, 2.952, 3.0, // 61-64
  ],
  medicare: {
    /** Part B standard monthly premium. Grows at the healthcare cost rate. */
    partBStandardMonthly: 202.9,
    /**
     * IRMAA: income two years back, per person per month. Thresholds are
     * indexed to inflation (the top tier is fixed in law through 2027; the
     * model indexes it too, a simplification). Surcharges grow with the
     * Part B premium.
     */
    irmaaThresholds: {
      single: [109_000, 137_000, 171_000, 205_000, 500_000],
      marriedFilingJointly: [218_000, 274_000, 342_000, 410_000, 750_000],
    },
    partBSurchargeMonthly: [0, 81.2, 202.8, 324.5, 446.2, 486.8],
    partDSurchargeMonthly: [0, 14.5, 37.5, 60.4, 83.3, 91.0],
  },
} as const;

/** The premium multiplier for a given age relative to a 21-year-old (64 and over share the top factor). */
export function ageCurveFactor(age: number): number {
  const table = HEALTHCARE_TABLES_2026.ageCurve;
  const i = Math.max(0, Math.min(table.length - 1, Math.floor(age)));
  return table[i];
}

/**
 * The share of income a household is expected to put toward the benchmark
 * plan, or null when no credit applies at that income.
 */
export function applicablePercentage(fplRatio: number, enhanced: boolean): number | null {
  const bands = enhanced ? HEALTHCARE_TABLES_2026.applicablePct.enhanced : HEALTHCARE_TABLES_2026.applicablePct.currentLaw;
  if (fplRatio < 1) return null;
  for (const b of bands) {
    if (fplRatio <= b.to) {
      const t = b.to === b.from ? 0 : (fplRatio - b.from) / (b.to - b.from);
      return b.pctFrom + (b.pctTo - b.pctFrom) * t;
    }
  }
  return enhanced ? HEALTHCARE_TABLES_2026.applicablePct.enhancedAboveCap : null;
}

/** The poverty line for a household of `size`, in `year` dollars. */
export function povertyLineFor(size: number, year: number, inflationRatePct: number): number {
  const { first, perAdditional } = HEALTHCARE_TABLES_2026.povertyLine;
  const factor = Math.pow(1 + inflationRatePct, year - HEALTHCARE_TABLES_2026.baseYear);
  return (first + perAdditional * Math.max(0, size - 1)) * factor;
}

/** Which IRMAA tier (0 = none, 5 = top) a household's income two years back lands in. */
export function irmaaTier(magiTwoYearsAgo: number, filingStatus: FilingStatus, year: number, inflationRatePct: number): number {
  const thresholds = HEALTHCARE_TABLES_2026.medicare.irmaaThresholds[filingStatus];
  const factor = Math.pow(1 + inflationRatePct, year - HEALTHCARE_TABLES_2026.baseYear);
  let tier = 0;
  for (const t of thresholds) {
    if (magiTwoYearsAgo > t * factor) tier += 1;
    else break;
  }
  return tier;
}

/**
 * The marketplace premium a household actually pays each month for the
 * people listed, after the premium tax credit. `benchmarkMonthly` is the
 * full price of their benchmark plans for this month, already aged and
 * grown; the credit caps the household's cost at a share of its income.
 */
export function marketplaceNetMonthly(input: {
  benchmarkMonthly: number;
  acaMagi: number;
  householdSize: number;
  year: number;
  inflationRatePct: number;
  premiumTaxCredit: boolean;
  enhancedSubsidies: boolean;
}): { net: number; credit: number; fplRatio: number | null } {
  const { benchmarkMonthly } = input;
  if (!input.premiumTaxCredit || benchmarkMonthly <= 0) return { net: benchmarkMonthly, credit: 0, fplRatio: null };
  const fpl = povertyLineFor(input.householdSize, input.year, input.inflationRatePct);
  const ratio = fpl > 0 ? Math.max(0, input.acaMagi) / fpl : 0;
  const pct = applicablePercentage(ratio, input.enhancedSubsidies);
  if (pct == null) return { net: benchmarkMonthly, credit: 0, fplRatio: ratio };
  const expectedMonthly = (Math.max(0, input.acaMagi) * pct) / 12;
  const net = Math.min(benchmarkMonthly, expectedMonthly);
  return { net, credit: benchmarkMonthly - net, fplRatio: ratio };
}

export type HealthcareChargeKind = "employer" | "cobra" | "retiree_plan" | "marketplace" | "medicare" | "irmaa" | "out_of_pocket";

export interface HealthcareCharge {
  /** Stable per-item key for the cash-flow breakdown, e.g. "healthcare:medicare:<personId>". */
  key: string;
  label: string;
  kind: HealthcareChargeKind;
  amount: number;
  /** The person this is for; null for a household-level line (the marketplace premium). */
  personId: Id | null;
}

export interface HealthcareMonthContext {
  month: ISODate;
  planStartDate: ISODate;
  /** Household members alive this month. */
  people: Person[];
  /** Whether this person has a salary running this month. */
  isWorking: (personId: Id) => boolean;
  /** Months since this person's last salary month; null if they never had one in the plan. */
  monthsSinceWorking: (personId: Id) => number | null;
  filingStatus: FilingStatus;
  /** This year's estimated marketplace income (adjusted gross income plus untaxed Social Security). */
  acaMagi: number;
  /** The household's adjusted gross income two years earlier, for IRMAA. */
  agiTwoYearsAgo: number;
  inflationRatePct: number;
}

/** Who pays what this month. Empty when the model is off. */
export function healthcareChargesForMonth(settings: HealthcareSettings, ctx: HealthcareMonthContext): HealthcareCharge[] {
  if (!settings.enabled) return [];
  const year = yearOf(ctx.month);
  const growth = settings.costGrowthRatePct ?? ctx.inflationRatePct;
  // User-entered amounts are today's dollars (as of the plan start); the
  // 2026 tables carry their own base year.
  const userFactor = Math.pow(1 + growth, Math.max(0, elapsedYears(ctx.planStartDate, ctx.month)));
  const tableFactor = Math.pow(1 + growth, Math.max(0, year - HEALTHCARE_TABLES_2026.baseYear));
  const anyoneWorking = ctx.people.some((p) => ctx.isWorking(p.id));
  const charges: HealthcareCharge[] = [];
  const marketplaceMembers: { person: Person; benchmark: number }[] = [];

  for (const person of ctx.people) {
    const age = ageOn(person.birthDate, ctx.month);
    if (age >= 65) {
      const m = HEALTHCARE_TABLES_2026.medicare;
      const partB = m.partBStandardMonthly * tableFactor;
      const partD = settings.medicare.partDMonthlyPremium * userFactor;
      const supplement = settings.medicare.supplementMonthlyPremium * userFactor;
      charges.push({
        key: `healthcare:medicare:${person.id}`,
        label: `Medicare: ${person.name}`,
        kind: "medicare",
        amount: partB + partD + supplement,
        personId: person.id,
      });
      if (settings.medicare.irmaa) {
        const tier = irmaaTier(ctx.agiTwoYearsAgo, ctx.filingStatus, year, ctx.inflationRatePct);
        const surcharge = (m.partBSurchargeMonthly[tier] + m.partDSurchargeMonthly[tier]) * tableFactor;
        if (surcharge > 0) {
          charges.push({
            key: `healthcare:irmaa:${person.id}`,
            label: `Medicare income surcharge (IRMAA): ${person.name}`,
            kind: "irmaa",
            amount: surcharge,
            personId: person.id,
          });
        }
      }
      const oop = (settings.outOfPocket.medicareAnnualPerPerson / 12) * userFactor;
      if (oop > 0) {
        charges.push({ key: `healthcare:oop:${person.id}`, label: `Out-of-pocket medical: ${person.name}`, kind: "out_of_pocket", amount: oop, personId: person.id });
      }
      continue;
    }

    const coveredByWork = ctx.isWorking(person.id) || (settings.spouseCoverageWhileWorking && anyoneWorking);
    if (coveredByWork) {
      const premium = settings.workingMonthlyPremiumPerPerson * userFactor;
      if (premium > 0) {
        charges.push({ key: `healthcare:employer:${person.id}`, label: `Health insurance (employer): ${person.name}`, kind: "employer", amount: premium, personId: person.id });
      }
    } else if (settings.retiredCoverage === "fixed") {
      const premium = settings.fixedMonthlyPremiumPerPerson * userFactor;
      if (premium > 0) {
        charges.push({ key: `healthcare:retiree:${person.id}`, label: `Health insurance (retiree plan): ${person.name}`, kind: "retiree_plan", amount: premium, personId: person.id });
      }
    } else if (settings.retiredCoverage === "none") {
      // Only out-of-pocket costs below.
    } else {
      const since = ctx.monthsSinceWorking(person.id);
      const onCobra = settings.retiredCoverage === "cobra_then_marketplace" && since != null && since <= settings.cobra.months;
      if (onCobra) {
        const premium = settings.cobra.monthlyPremiumPerPerson * userFactor;
        if (premium > 0) {
          charges.push({ key: `healthcare:cobra:${person.id}`, label: `COBRA: ${person.name}`, kind: "cobra", amount: premium, personId: person.id });
        }
      } else {
        const ageFactor = settings.marketplace.ageRated
          ? ageCurveFactor(age) / ageCurveFactor(ageOn(person.birthDate, ctx.planStartDate))
          : 1;
        marketplaceMembers.push({ person, benchmark: settings.marketplace.benchmarkMonthlyPremiumPerPerson * ageFactor * userFactor });
      }
    }
    const oop = (settings.outOfPocket.preMedicareAnnualPerPerson / 12) * userFactor;
    if (oop > 0) {
      charges.push({ key: `healthcare:oop:${person.id}`, label: `Out-of-pocket medical: ${person.name}`, kind: "out_of_pocket", amount: oop, personId: person.id });
    }
  }

  if (marketplaceMembers.length > 0) {
    const benchmark = marketplaceMembers.reduce((s, m) => s + m.benchmark, 0);
    const { net } = marketplaceNetMonthly({
      benchmarkMonthly: benchmark,
      acaMagi: ctx.acaMagi,
      householdSize: ctx.people.length,
      year,
      inflationRatePct: ctx.inflationRatePct,
      premiumTaxCredit: settings.marketplace.premiumTaxCredit,
      enhancedSubsidies: settings.marketplace.enhancedSubsidies,
    });
    if (net > 0) {
      const single = marketplaceMembers.length === 1 ? marketplaceMembers[0].person : null;
      charges.push({
        key: "healthcare:marketplace",
        label: single ? `Marketplace health insurance: ${single.name}` : "Marketplace health insurance",
        kind: "marketplace",
        amount: net,
        personId: single?.id ?? null,
      });
    }
  }
  return charges;
}

/** True for a cash-flow line item the healthcare model produced. */
export function isHealthcareItemId(id: string): boolean {
  return id.startsWith("healthcare:");
}
