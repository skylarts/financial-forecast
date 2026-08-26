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
   * Whether a linked account's value is written into the forecast on its own.
   *
   * On by default, so linking an account is all it takes to keep the forecast's
   * starting balance current. Turn it off to keep the link -- and the side-by-side
   * comparison it gives you -- for an account whose forecast entry stands for more
   * than the slice tracked here, where an automatic write would understate it.
   */
  syncToForecast: z.boolean().default(true),
  /**
   * Which person in the forecast household this account belongs to, by their
   * `Person.id`. Null means joint -- the same convention forecast accounts use
   * (see `ownerId` in `src/domain/account.ts`), so the two sides read alike.
   *
   * Held here rather than read through `forecastAccountId` so an account tracked
   * only in the portfolio still has an owner.
   */
  ownerId: idSchema.nullable().default(null),
  /**
   * Cash the account held before its first recorded transaction.
   *
   * Only a seed, never the current balance: cash on hand is replayed from the
   * ledger's own movements like everything else here (see `accountCashBalances`).
   * A ledger that runs from the account's opening leaves this at zero; one built
   * from an export that begins mid-history sets it to what the first statement
   * opened with.
   *
   * This field used to hold the *current* balance, typed in by hand and updated
   * by nothing. Old saves are read without it -- their value described a balance
   * the ledger now derives, and carrying it forward as a seed would count those
   * same dollars a second time.
   */
  openingCashBalance: z.number().default(0),
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
