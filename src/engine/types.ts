import type { Id, ISODate, Account, LoanTerms, TimelineRow } from "@/domain";

/** An Account plus the date it starts participating in the simulation. */
export interface EngineAccount extends Account {
  effectiveStartDate: ISODate;
  /**
   * The account's growthRateSchedule entries, sorted ascending by startDate.
   * The engine uses the last entry whose startDate has passed as of the
   * current month, replacing growthRatePct / propertyGrowthRatePct.
   */
  growthRateOverrides?: { startDate: ISODate; growthRatePct: number }[];
  /**
   * Set by a sell_home event on the real_estate account being sold and its
   * linked mortgage (if any) -- the balance is forced to exactly $0 starting
   * this month (an actual retirement, not just a frozen balance) and stays
   * there, since the sale's net-proceeds figure already accounts for paying
   * off whatever was left on the mortgage.
   */
  soldDate?: ISODate;
  /**
   * Present (on the real_estate account only) when its sell_home event uses
   * the computed-proceeds mode: at the sale month the engine credits
   * simulated value × (1 − sellingCostsPct) − remaining linked-mortgage
   * balance to proceedsAccountId (null = the spending hub), instead of the
   * event's fixed netProceeds figure.
   */
  saleInfo?: { sellingCostsPct: number; proceedsAccountId: Id | null };
}

export type PostingCategory =
  | "income"
  | "expense"
  | "transfer"
  /** Deposit into a contribution target account (grows the account). */
  | "contribution_in"
  /** Matching draw from the spending account for an after-tax contribution. */
  | "contribution_out";

/**
 * What a transfer between two accounts is, tax-wise, decided from the two
 * accounts' treatments when the posting is built:
 *  - "rollover"   tax-deferred to tax-deferred: not a taxable event.
 *  - "conversion" tax-deferred to tax-free (a Roth conversion): ordinary
 *                 income in the year it happens, never the 10% penalty, tax
 *                 paid from the spending hub rather than withheld from the IRA.
 *  - "payoff"     into a liability: pays the debt down.
 *  - "plain"      anything else: an outflow from a taxable or tax-deferred
 *                 account is a sale or distribution and is taxed as one.
 */
export type TransferKind = "rollover" | "conversion" | "payoff" | "plain";

export interface Posting {
  /** Exact day, used for warnings. */
  date: ISODate;
  /** 'YYYY-MM', used to bucket into the monthly simulation loop. */
  yearMonth: string;
  accountId: Id;
  /** Signed: positive = inflow, negative = outflow. */
  amount: number;
  category: PostingCategory;
  label: string;
  /**
   * Stable grouping key for the per-item cash-flow breakdown -- the originating
   * income source / expense / event. Not necessarily an Account id. Ids only
   * need to be consistent within a single projection run (they are regenerated
   * each run for event-synthesized sources), which is fine since the breakdown
   * is computed in the same pass.
   */
  sourceId: Id;
  /**
   * Gross (Box-1-style) counterpart to `amount`, present only on a salary
   * income posting whose source has `grossAmount` set -- scaled by the same
   * inflation/growth/adjustment factors as `amount`. Used only for federal
   * tax bracket placement (see YearAccumulator.grossSalary in
   * forecastScenario.ts); never posted to any account balance.
   */
  grossAmount?: number;
  /** Present on both legs of a custom transfer. See TransferKind. */
  transferKind?: TransferKind;
  /** The other account of a transfer leg. */
  counterpartyAccountId?: Id;
  /**
   * A transfer whose size is only known at run time: "the whole balance" of
   * the source (a rollover), or "whatever is left on the loan" (a payoff).
   * Carried on a single posting from the source; the engine sizes it and
   * moves the money to `counterpartyAccountId` itself.
   */
  wholeBalance?: boolean;
  /** Roth conversion only: where the tax on it comes from. */
  taxSource?: "cash" | "withhold";
  /**
   * contribution_in only: whether this particular contribution came out of the
   * paycheck before it landed (no cash outflow) or out of take-home (a real
   * one). It rides on the posting because the answer belongs to the
   * contribution *occurrence*, not to the account -- a `contributionSchedule`
   * can change the funding source partway through the plan, and its segments
   * never touch the account's single `contribution` field.
   */
  payrollDeducted?: boolean;
}

/**
 * A "fill to the top of a bracket" Roth conversion, applied by the engine in
 * December once the year's ordinary income is known.
 */
export interface BracketFillRule {
  eventId: Id;
  label: string;
  fromAccountId: Id;
  toAccountId: Id;
  /** The bracket whose top to fill up to, e.g. 0.12. */
  bracketRate: number;
  startDate: ISODate;
  endDate: ISODate | null;
  oneTime: boolean;
  taxSource: "cash" | "withhold";
}

export interface MortgageSpec {
  accountId: Id;
  loanTerms: LoanTerms;
  /** Account the monthly payment is drawn from. */
  payingAccountId: Id | null;
  /** No further payments are charged after this date (e.g. a buy_home event's
   *  "replace existing housing expenses" retiring an already-owned home's
   *  mortgage) -- the remaining balance simply stops amortizing. */
  paymentEndDate?: ISODate;
}

export interface ResolvedSchedule {
  accounts: EngineAccount[];
  postings: Posting[];
  mortgages: MortgageSpec[];
  timeline: TimelineRow[];
  bracketFills: BracketFillRule[];
  /**
   * For each person, the months ("YYYY-MM") in which they have a salary
   * running -- the healthcare model's definition of "working". Empty for a
   * person with no salary in the plan.
   */
  workingMonths: Map<Id, Set<string>>;
}
