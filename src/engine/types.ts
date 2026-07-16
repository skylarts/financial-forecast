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
}

export type PostingCategory =
  | "income"
  | "expense"
  | "transfer"
  /** Deposit into a contribution target account (grows the account). */
  | "contribution_in"
  /** Matching draw from the spending account for an after-tax contribution. */
  | "contribution_out";

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
}

export interface MortgageSpec {
  accountId: Id;
  loanTerms: LoanTerms;
  /** Account the monthly payment is drawn from. */
  payingAccountId: Id | null;
}

export interface ResolvedSchedule {
  accounts: EngineAccount[];
  postings: Posting[];
  mortgages: MortgageSpec[];
  timeline: TimelineRow[];
}
