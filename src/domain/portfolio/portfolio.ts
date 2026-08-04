import { z } from "zod";
import { idSchema } from "../common";
import { securitySchema } from "./security";
import { transactionSchema } from "./transaction";

export const portfolioAccountTypeSchema = z.enum([
  "taxable",
  "traditional_ira",
  "roth_ira",
  "traditional_401k",
  "roth_401k",
  "hsa",
  "529",
  "other",
]);
export type PortfolioAccountType = z.infer<typeof portfolioAccountTypeSchema>;

export const PORTFOLIO_ACCOUNT_TYPE_LABELS: Record<PortfolioAccountType, string> = {
  taxable: "Taxable brokerage",
  traditional_ira: "Traditional IRA",
  roth_ira: "Roth IRA",
  traditional_401k: "Traditional 401(k)",
  roth_401k: "Roth 401(k)",
  hsa: "HSA",
  "529": "529",
  other: "Other",
};

export const portfolioAccountSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  institution: z.string().default(""),
  type: portfolioAccountTypeSchema.default("taxable"),
  /**
   * The forecast-side account this one feeds. Set it and the tracker can push
   * its computed market value into the forecast's starting balance, so the
   * two tools stop drifting apart. Null means this account is tracked here
   * only.
   */
  forecastAccountId: idSchema.nullable().default(null),
  /**
   * Uninvested cash sitting in the account. Tracked as a running balance
   * rather than a position because no statement reports it as a lot.
   */
  cashBalance: z.number().default(0),
});
export type PortfolioAccount = z.infer<typeof portfolioAccountSchema>;

/**
 * The whole tracker's persisted state. Transactions are the single source of
 * truth -- holdings, tax lots, and every performance figure are replayed from
 * them rather than stored, so an edited or reimported row can never leave a
 * stale derived total behind.
 */
export const portfolioSchema = z.object({
  id: idSchema,
  accounts: z.array(portfolioAccountSchema).default([]),
  transactions: z.array(transactionSchema).default([]),
  securities: z.array(securitySchema).default([]),
});
export type Portfolio = z.infer<typeof portfolioSchema>;
