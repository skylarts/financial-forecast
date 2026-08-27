import type { PortfolioAccountType } from "@/domain/portfolio";

/**
 * The two pots a workplace plan keeps money in, and the vocabulary statements
 * use to name them.
 *
 * A 401(k) or 457 is one account at the custodian but two accounts for tax
 * purposes: pre-tax dollars are taxed on the way out, Roth dollars are not.
 * The forecast has to see them separately (its withdrawal engine keys off a
 * single tax treatment per account), so the tracker splits such an account
 * into two sleeves and files every transaction under one of them.
 *
 * This module is the one place that knows what those pots are called, so the
 * split action and the importer's source-column routing agree by construction
 * rather than by two lists that drift.
 */
export type TaxSource = "pretax" | "roth";

export interface TaxSourceSleeve {
  source: TaxSource;
  /** The sleeve's name, as it reads under its parent: "401(k) / Pre-tax". */
  name: string;
}

export const TAX_SOURCE_SLEEVES: readonly TaxSourceSleeve[] = [
  { source: "pretax", name: "Pre-tax" },
  { source: "roth", name: "Roth" },
];

export const TAX_SOURCE_LABELS: Record<TaxSource, string> = {
  pretax: "Pre-tax",
  roth: "Roth",
};

/**
 * The account type a sleeve should carry, given what its parent is.
 *
 * The type enum has no 457 of its own, and does not need one: what the tracker
 * does with the type is decide how the money is taxed, and a 457's two pots are
 * taxed exactly like a 401(k)'s. So anything that is not recognisably an IRA
 * takes the 401(k) pair -- which is also the right answer for a parent still
 * left at the default "taxable" because the user split it before setting its
 * type.
 */
export function sleeveTypeFor(
  parentType: PortfolioAccountType,
  source: TaxSource,
): PortfolioAccountType {
  const isIra = parentType === "traditional_ira" || parentType === "roth_ira";
  if (isIra) return source === "roth" ? "roth_ira" : "traditional_ira";
  return source === "roth" ? "roth_401k" : "traditional_401k";
}

/**
 * Patterns ordered so the most specific claim wins. Roth is tested first
 * throughout: Empower prints "ROTH CONTRIBUTION" alongside "EMPLOYEE BEFORE
 * TAX-VOLUNTARY", and a label can carry both words ("Roth before-tax
 * conversion") where the Roth reading is the correct one.
 */
const SOURCE_PATTERNS: { source: TaxSource; patterns: RegExp[] }[] = [
  { source: "roth", patterns: [/\broth\b/i, /after[\s-]*tax/i] },
  {
    source: "pretax",
    patterns: [
      /before[\s-]*tax/i,
      /\bpre[\s-]*tax\b/i,
      /\btraditional\b/i,
      // Employer money -- match, profit sharing, non-elective -- is pre-tax by
      // law in every plan that does not offer in-plan Roth treatment of it,
      // and every statement seen here files it under the pre-tax total.
      /\bemployer\b/i,
      /\bmatch(ing)?\b/i,
      /profit[\s-]*sharing/i,
    ],
  },
];

/**
 * Which pot a statement's source label refers to, or null when the label says
 * nothing about tax treatment.
 *
 * Null is a real answer, not a failure: the importer maps each distinct source
 * value to a sleeve explicitly, and this only supplies the opening guess. A
 * wrong guess silently accepted would put Roth dollars in the pre-tax pot and
 * overstate the plan's future tax bill for decades, so anything unrecognised
 * is handed to the user rather than assumed.
 */
export function classifyTaxSource(label: string): TaxSource | null {
  const text = label.trim();
  if (!text) return null;
  for (const { source, patterns } of SOURCE_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return source;
  }
  return null;
}
