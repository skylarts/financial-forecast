import type { Account, DateAnchor, ExpenseCategory, IncomeCategory, Person, RecurrenceFrequency, TemporaryAdjustment } from "@/domain";
import { addMonths, birthdayAtAge } from "@/engine/dateMath";
import { nanoid } from "nanoid";

/**
 * The life-event catalog: every standard US life event as a one-click
 * starting point. A template is NOT a new kind of record -- it is a preset
 * over the primitives the plan already has (an income, an expense, one of
 * the event drawers, a temporary adjustment on a salary, or a setting in
 * Assumptions). Picking one opens the ordinary drawer with the right
 * category, cadence, dates and account already chosen, so the person types
 * one or two numbers and saves. Every advanced control stays exactly where
 * it was, behind the same disclosure, for the plan that needs it.
 *
 * Dates are rules, not values: "when the owner turns 82", "from retirement
 * for 15 years", "starting today for 5 years". They resolve against the
 * household when the template is picked (see resolveTemplate), and the ones
 * that follow a retirement are written as anchors so they keep moving with it.
 */

/** When a seeded item starts. */
export type StartRule =
  | "today"
  /** The owner's birthday at this age. */
  | { atAge: number }
  /** Months from the owner's retirement (0 = the day they retire). Written as an anchor. */
  | { retirement: number };

/** When a seeded item ends. */
export type EndRule =
  | null
  /** N years after it starts. */
  | { afterYears: number }
  /** The owner's birthday at this age. */
  | { atAge: number }
  /** Months from the owner's retirement. Written as an anchor. */
  | { retirement: number };

interface SeedBase {
  name: string;
  frequency?: RecurrenceFrequency;
  start?: StartRule;
  end?: EndRule;
  /** Percent as a fraction; null = matches inflation (the app-wide default). */
  growthRatePct?: number | null;
  intervalYears?: number;
  /** One line shown at the top of the drawer: what this template assumed, so it can be changed. */
  note?: string;
}

export interface IncomeTemplateSeed extends SeedBase {
  category: IncomeCategory;
  /** Social Security / pension: the age it starts. "retirementAge" = the owner's retirement age. */
  claimAge?: number | "retirementAge";
  /** Prefer landing the money in the first account of this class (else the spending hub). */
  depositAccountClass?: Account["class"];
}

export interface ExpenseTemplateSeed extends SeedBase {
  category: ExpenseCategory;
  /** Prefer paying from the first account of this class (else the spending hub). */
  paymentAccountClass?: Account["class"];
}

export type LifeEventGroup = "Family" | "Work & income" | "Home" | "Cars & big purchases" | "Health & later life" | "Money moves";

export type LifeEventTarget =
  | { kind: "income"; seed: IncomeTemplateSeed }
  | { kind: "expense"; seed: ExpenseTemplateSeed }
  /** One of the existing event drawers, by its picker key. */
  | { kind: "event"; type: "buy_home" | "sell_home" | "heloc" | "open_loan" | "refinance" | "pay_off_loan" | "roth_conversion" | "rollover" | "custom_transfer" }
  /** A temporary change to an existing salary (a break, a cut, a raise). */
  | { kind: "adjustment"; multiplier: number; months: number | null; note: string }
  /** Lives in Assumptions (retirement age, healthcare, planning-end age). */
  | { kind: "assumptions"; note: string };

export interface LifeEventTemplate {
  id: string;
  group: LifeEventGroup;
  label: string;
  hint: string;
  /** Extra words the search box should match. */
  keywords?: string[];
  target: LifeEventTarget;
}

export const LIFE_EVENT_GROUPS: LifeEventGroup[] = ["Family", "Work & income", "Home", "Cars & big purchases", "Health & later life", "Money moves"];

export const LIFE_EVENT_TEMPLATES: LifeEventTemplate[] = [
  // ---- Family ----
  {
    id: "wedding",
    group: "Family",
    label: "Get married",
    hint: "A one-time wedding cost on a date",
    keywords: ["marriage", "wedding", "honeymoon"],
    target: { kind: "expense", seed: { name: "Wedding", category: "discretionary", frequency: "one_time", start: "today", note: "One-time, paid from the spending hub. Filing status lives in Assumptions." } },
  },
  {
    id: "baby",
    group: "Family",
    label: "Have a baby",
    hint: "Childcare each month until school age, starting on a date",
    keywords: ["child", "kid", "daycare", "childcare", "birth", "adopt"],
    target: {
      kind: "expense",
      seed: { name: "Childcare", category: "childcare", frequency: "monthly", start: "today", end: { afterYears: 5 }, note: "Runs 5 years -- daycare until kindergarten. Add a one-time expense for first-year costs if you like." },
    },
  },
  {
    id: "college",
    group: "Family",
    label: "Kid starts college",
    hint: "Tuition once a year for four years, paid from a 529 if you have one",
    keywords: ["tuition", "university", "529", "school", "education"],
    target: {
      kind: "expense",
      seed: { name: "College tuition", category: "other", frequency: "annual", start: "today", end: { afterYears: 4 }, paymentAccountClass: "education_529", growthRatePct: 0.05, note: "Four annual payments, growing 5%/yr (tuition outruns inflation). Paid from your 529 when there is one." },
    },
  },
  {
    id: "support-family",
    group: "Family",
    label: "Support a parent or family member",
    hint: "A monthly amount you send or spend on their behalf",
    keywords: ["parent", "elder", "caregiving", "allowance", "dependent"],
    target: { kind: "expense", seed: { name: "Family support", category: "other", frequency: "monthly", start: "today", end: null, note: "Give it an end date if you know one." } },
  },
  {
    id: "gift",
    group: "Family",
    label: "Gift money to family",
    hint: "A one-time or yearly gift -- a down payment, a wedding, a head start",
    keywords: ["gift", "down payment", "kids", "annual exclusion"],
    target: { kind: "expense", seed: { name: "Gift to family", category: "discretionary", frequency: "one_time", start: "today", note: "Switch Frequency to Annual for a yearly gift." } },
  },

  // ---- Work & income ----
  {
    id: "new-job",
    group: "Work & income",
    label: "New job or raise",
    hint: "A salary that runs until you retire",
    keywords: ["salary", "job", "raise", "promotion", "paycheck", "wages"],
    target: { kind: "income", seed: { name: "Salary", category: "salary", frequency: "monthly", start: "today", end: { retirement: 0 }, note: "Take-home pay per month. Ends the day before retirement and moves if that age changes. For a raise on a salary already here, edit that salary instead." } },
  },
  {
    id: "bonus",
    group: "Work & income",
    label: "Bonus or one-time payment",
    hint: "Money that arrives once on a date",
    keywords: ["bonus", "commission", "stock", "rsu", "vesting", "severance", "settlement"],
    target: { kind: "income", seed: { name: "Bonus", category: "other", frequency: "one_time", start: "today", note: "After-tax amount. Set Every N years for a bonus that repeats." } },
  },
  {
    id: "career-break",
    group: "Work & income",
    label: "Career break or sabbatical",
    hint: "Pause a salary for a while, then it resumes on its own",
    keywords: ["sabbatical", "leave", "parental", "gap", "unemployed", "layoff", "lose job"],
    target: { kind: "adjustment", multiplier: 0, months: 12, note: "Career break" },
  },
  {
    id: "part-time",
    group: "Work & income",
    label: "Go part-time",
    hint: "Cut a salary to a share of itself for a stretch",
    keywords: ["part time", "reduce hours", "phased retirement", "half"],
    target: { kind: "adjustment", multiplier: 0.5, months: null, note: "Part-time" },
  },
  {
    id: "retirement-work",
    group: "Work & income",
    label: "Work in retirement",
    hint: "Consulting or a part-time job after you retire",
    keywords: ["consulting", "side", "gig", "encore", "retire"],
    target: { kind: "income", seed: { name: "Part-time work", category: "other", frequency: "monthly", start: { retirement: 0 }, end: { retirement: 60 }, note: "Starts when you retire and runs 5 years; both dates follow your retirement age." } },
  },
  {
    id: "social-security",
    group: "Work & income",
    label: "Start Social Security",
    hint: "Your benefit at the age you claim it",
    keywords: ["ssa", "benefit", "claim", "62", "67", "70"],
    target: { kind: "income", seed: { name: "Social Security", category: "social_security", frequency: "monthly", claimAge: 67, end: null, note: "Claiming at 67 (full retirement age). Enter the gross monthly benefit from your SSA statement; tax is computed each year." } },
  },
  {
    id: "pension",
    group: "Work & income",
    label: "Start a pension",
    hint: "A monthly pension from the day you retire",
    keywords: ["pension", "annuity", "defined benefit", "trs", "fers"],
    target: { kind: "income", seed: { name: "Pension", category: "pension", frequency: "monthly", claimAge: "retirementAge", end: null, growthRatePct: 0, note: "Starts at your retirement age with no cost-of-living increase -- set a growth rate if yours has a COLA, and a survivor share under Advanced." } },
  },
  {
    id: "rental-income",
    group: "Work & income",
    label: "Rental income",
    hint: "Rent you collect each month",
    keywords: ["rent", "landlord", "tenant", "property"],
    target: { kind: "income", seed: { name: "Rental income", category: "rental", frequency: "monthly", start: "today", end: null, note: "Net of the property's own costs is simplest. Grows with inflation." } },
  },
  {
    id: "inheritance",
    group: "Work & income",
    label: "Inheritance or windfall",
    hint: "A lump sum that lands in an investment account",
    keywords: ["inherit", "windfall", "lottery", "estate", "life insurance", "payout"],
    target: { kind: "income", seed: { name: "Inheritance", category: "other", frequency: "one_time", start: "today", depositAccountClass: "taxable_investment", note: "Lands in your brokerage when you have one, else the spending hub. Inheritances are generally not taxable income." } },
  },

  // ---- Home ----
  { id: "buy-home", group: "Home", label: "Buy a home", hint: "Creates the home and its mortgage, pays the down payment", keywords: ["house", "mortgage", "purchase", "closing"], target: { kind: "event", type: "buy_home" } },
  { id: "sell-home", group: "Home", label: "Sell a home", hint: "Retires its loans and credits the proceeds", keywords: ["house", "downsize", "move", "sale"], target: { kind: "event", type: "sell_home" } },
  { id: "downsize", group: "Home", label: "Downsize or move", hint: "Sell this home, then add Buy a home for the next one", keywords: ["downsize", "relocate", "move", "smaller"], target: { kind: "event", type: "sell_home" } },
  {
    id: "refinance",
    group: "Home",
    label: "Refinance a mortgage",
    hint: "Swap a loan's rate and term on a date, optionally taking cash out",
    keywords: ["refi", "rate", "lower payment", "cash out", "recast"],
    target: { kind: "event", type: "refinance" },
  },
  { id: "heloc", group: "Home", label: "Home equity line (HELOC)", hint: "Borrow against a home: interest-only while you draw, then repaid", keywords: ["equity", "line of credit", "renovation", "borrow"], target: { kind: "event", type: "heloc" } },
  {
    id: "renovation",
    group: "Home",
    label: "Renovate the home",
    hint: "A one-time project paid from savings",
    keywords: ["remodel", "kitchen", "roof", "addition", "repair"],
    target: { kind: "expense", seed: { name: "Home renovation", category: "housing", frequency: "one_time", start: "today", note: "Paid from the spending hub. Borrowing for it? Use Home equity line instead." } },
  },
  { id: "rental-property", group: "Home", label: "Buy a rental or second home", hint: "Another property, financed or not -- add its rent as Rental income", keywords: ["investment property", "vacation home", "cabin", "airbnb"], target: { kind: "event", type: "buy_home" } },
  {
    id: "moving",
    group: "Home",
    label: "Moving costs",
    hint: "Movers, deposits, and the rest of a relocation, once",
    keywords: ["relocate", "movers", "deposit"],
    target: { kind: "expense", seed: { name: "Moving costs", category: "housing", frequency: "one_time", start: "today" } },
  },

  // ---- Cars & big purchases ----
  {
    id: "car-cash",
    group: "Cars & big purchases",
    label: "Buy a car with cash",
    hint: "A car every few years, paid outright",
    keywords: ["vehicle", "auto", "truck", "replace"],
    target: { kind: "expense", seed: { name: "New car", category: "transportation", frequency: "annual", intervalYears: 7, start: "today", end: null, note: "Repeats every 7 years -- the typical ownership stretch. Set Every N years to blank for a single purchase." } },
  },
  { id: "car-loan", group: "Cars & big purchases", label: "Buy a car with a loan", hint: "Finance it: creates the loan and its monthly payment", keywords: ["vehicle", "auto", "finance", "lease"], target: { kind: "event", type: "open_loan" } },
  {
    id: "big-purchase",
    group: "Cars & big purchases",
    label: "Big one-time purchase",
    hint: "A boat, an RV, furniture, a piano -- anything bought once",
    keywords: ["boat", "rv", "furniture", "electronics"],
    target: { kind: "expense", seed: { name: "Big purchase", category: "discretionary", frequency: "one_time", start: "today" } },
  },
  {
    id: "travel",
    group: "Cars & big purchases",
    label: "Travel in early retirement",
    hint: "A yearly travel budget for the first years after you retire",
    keywords: ["vacation", "trip", "go-go years", "bucket list"],
    target: { kind: "expense", seed: { name: "Travel", category: "discretionary", frequency: "annual", start: { retirement: 0 }, end: { retirement: 180 }, note: "Runs 15 years from retirement -- the years most people travel most. Both dates follow your retirement age." } },
  },

  // ---- Health & later life ----
  { id: "retire", group: "Health & later life", label: "Retire", hint: "Set the age in Assumptions -- salaries, contributions and everything linked to it follow", keywords: ["retirement", "quit", "stop working"], target: { kind: "assumptions", note: "Retirement is a property of a person, not an event: change the age under Household in Assumptions and every date linked to it moves." } },
  { id: "medicare", group: "Health & later life", label: "Medicare and health coverage", hint: "Premiums before and after 65 are modelled in Assumptions", keywords: ["health insurance", "aca", "cobra", "premium", "65"], target: { kind: "assumptions", note: "The healthcare model in Assumptions already charges pre-65 premiums, Medicare and out-of-pocket costs by age. Adjust it there." } },
  {
    id: "long-term-care",
    group: "Health & later life",
    label: "Long-term care",
    hint: "Assisted living or in-home care from a late age",
    keywords: ["nursing", "assisted living", "memory care", "ltc", "aging"],
    target: { kind: "expense", seed: { name: "Long-term care", category: "healthcare", frequency: "monthly", start: { atAge: 82 }, end: null, growthRatePct: 0.05, note: "Starts at 82 and runs to the end of the plan, growing 5%/yr. The healthcare model does not include this." } },
  },
  {
    id: "medical",
    group: "Health & later life",
    label: "Major medical expense",
    hint: "A surgery, a procedure, a bad year -- once",
    keywords: ["surgery", "hospital", "dental", "deductible"],
    target: { kind: "expense", seed: { name: "Medical expense", category: "healthcare", frequency: "one_time", start: "today", note: "Out-of-pocket, beyond what the healthcare model already charges." } },
  },
  { id: "death", group: "Health & later life", label: "Death of a spouse", hint: "Each person's planning-end age is in Assumptions; survivor rules follow from it", keywords: ["widow", "survivor", "life expectancy", "pass away"], target: { kind: "assumptions", note: "Set the person's planning-end age under Household in Assumptions. Their salary and spending stop, Social Security keeps the larger benefit, and a pension pays its survivor share." } },

  // ---- Money moves ----
  { id: "roth", group: "Money moves", label: "Roth conversion", hint: "Move pre-tax money to a Roth and pay the tax now", keywords: ["convert", "ira", "bracket"], target: { kind: "event", type: "roth_conversion" } },
  { id: "rollover", group: "Money moves", label: "Rollover", hint: "Move a 401(k) to an IRA, no tax", keywords: ["401k", "ira", "transfer"], target: { kind: "event", type: "rollover" } },
  { id: "payoff", group: "Money moves", label: "Pay off a loan", hint: "Pay a mortgage or loan down, or off, from an account", keywords: ["mortgage", "debt", "extra payment"], target: { kind: "event", type: "pay_off_loan" } },
  { id: "loan", group: "Money moves", label: "Take out a loan", hint: "A student, personal or other fixed loan", keywords: ["borrow", "student loan", "personal loan"], target: { kind: "event", type: "open_loan" } },
  {
    id: "charity",
    group: "Money moves",
    label: "Charitable giving",
    hint: "A yearly amount you give",
    keywords: ["donate", "tithe", "church", "nonprofit"],
    target: { kind: "expense", seed: { name: "Charitable giving", category: "discretionary", frequency: "annual", start: "today", end: null } },
  },
  { id: "transfer", group: "Money moves", label: "Custom transfer", hint: "Any other move between two of your accounts", keywords: ["move money", "sweep"], target: { kind: "event", type: "custom_transfer" } },
];

// ---------------------------------------------------------------------------
// Resolution: turn a template's rules into concrete field values.
// ---------------------------------------------------------------------------

export interface TemplateContext {
  people: readonly Person[];
  accounts: readonly Account[];
  /** The plan's effective start date (today when the plan floats). */
  planStartDate: string;
}

/** The drawer-facing shape of a seeded income: plain field values, already resolved. */
export interface ResolvedIncomeSeed {
  /** The template this came from, kept on the record so the chart can show its own icon. */
  templateId: string;
  name: string;
  category: IncomeCategory;
  ownerId: string | null;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate: string | null;
  startAnchor: DateAnchor | null;
  endAnchor: DateAnchor | null;
  growthRatePct: number | null;
  intervalYears?: number;
  depositAccountId: string | null;
  claimAge?: number;
  note?: string;
}

export interface ResolvedExpenseSeed {
  /** The template this came from, kept on the record so the chart can show its own icon. */
  templateId: string;
  name: string;
  category: ExpenseCategory;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate: string | null;
  startAnchor: DateAnchor | null;
  endAnchor: DateAnchor | null;
  growthRatePct: number | null;
  intervalYears?: number;
  paymentAccountId: string | null;
  note?: string;
}

export type ResolvedTemplate =
  | { kind: "income"; seed: ResolvedIncomeSeed }
  | { kind: "expense"; seed: ResolvedExpenseSeed }
  | { kind: "event"; type: Extract<LifeEventTarget, { kind: "event" }>["type"]; templateId: string }
  | { kind: "adjustment"; adjustment: TemporaryAdjustment; note: string }
  | { kind: "assumptions"; note: string };

/** The person a template's ages and retirement follow: the first in the household. */
function ownerOf(ctx: TemplateContext): Person | undefined {
  return ctx.people[0];
}

function anchorFor(owner: Person | undefined, offsetMonths: number): DateAnchor | null {
  return owner ? { personId: owner.id, point: "retirement", offsetMonths } : null;
}

function resolveDates(seed: SeedBase, owner: Person | undefined, ctx: TemplateContext) {
  let startDate = ctx.planStartDate;
  let startAnchor: DateAnchor | null = null;
  const start = seed.start ?? "today";
  if (start !== "today") {
    if ("atAge" in start) startDate = owner ? birthdayAtAge(owner.birthDate, start.atAge) : ctx.planStartDate;
    else startAnchor = anchorFor(owner, start.retirement);
  }
  let endDate: string | null = null;
  let endAnchor: DateAnchor | null = null;
  const end = seed.end ?? null;
  if (end) {
    if ("afterYears" in end) endDate = addMonths(startDate, end.afterYears * 12);
    else if ("atAge" in end) endDate = owner ? birthdayAtAge(owner.birthDate, end.atAge) : null;
    else endAnchor = anchorFor(owner, end.retirement);
  }
  // An anchored date is recomputed by the app; the typed value is a placeholder
  // the drawer overwrites on resolve. Leave it blank so nothing stale shows.
  return { startDate: startAnchor ? "" : startDate, startAnchor, endDate: endAnchor ? null : endDate, endAnchor };
}

function firstAccountOfClass(ctx: TemplateContext, cls: Account["class"] | undefined): string | null {
  if (!cls) return null;
  return ctx.accounts.find((a) => a.class === cls && !a.isExcluded)?.id ?? null;
}

export function resolveTemplate(template: LifeEventTemplate, ctx: TemplateContext): ResolvedTemplate {
  const t = template.target;
  const owner = ownerOf(ctx);
  switch (t.kind) {
    case "income": {
      const s = t.seed;
      const dates = resolveDates(s, owner, ctx);
      const claimAge = s.claimAge === "retirementAge" ? owner?.retirementAge : s.claimAge;
      // A benefit's start is its claiming age -- the drawer derives the date
      // from the owner's birthday, so hand it the age and the matching date.
      const startDate = claimAge != null && owner ? birthdayAtAge(owner.birthDate, claimAge) : dates.startDate;
      return {
        kind: "income",
        seed: {
          templateId: template.id,
          name: s.name,
          category: s.category,
          ownerId: owner?.id ?? null,
          frequency: s.frequency ?? "monthly",
          startDate,
          endDate: dates.endDate,
          startAnchor: claimAge != null ? null : dates.startAnchor,
          endAnchor: dates.endAnchor,
          growthRatePct: s.growthRatePct ?? null,
          intervalYears: s.intervalYears,
          depositAccountId: firstAccountOfClass(ctx, s.depositAccountClass),
          claimAge: claimAge ?? undefined,
          note: s.note,
        },
      };
    }
    case "expense": {
      const s = t.seed;
      const dates = resolveDates(s, owner, ctx);
      return {
        kind: "expense",
        seed: {
          templateId: template.id,
          name: s.name,
          category: s.category,
          frequency: s.frequency ?? "monthly",
          ...dates,
          growthRatePct: s.growthRatePct ?? null,
          intervalYears: s.intervalYears,
          paymentAccountId: firstAccountOfClass(ctx, s.paymentAccountClass),
          note: s.note,
        },
      };
    }
    case "adjustment":
      return {
        kind: "adjustment",
        adjustment: {
          id: nanoid(),
          startDate: ctx.planStartDate,
          endDate: t.months == null ? null : addMonths(ctx.planStartDate, t.months),
          multiplier: t.multiplier,
          note: t.note,
        },
        note: t.note,
      };
    case "event":
      return { kind: "event", type: t.type, templateId: template.id };
    case "assumptions":
      return { kind: "assumptions", note: t.note };
  }
}

/** Case-insensitive match on label, hint and keywords; blank query = everything. */
export function searchTemplates(query: string, templates: LifeEventTemplate[] = LIFE_EVENT_TEMPLATES): LifeEventTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return templates;
  return templates.filter((t) => [t.label, t.hint, ...(t.keywords ?? [])].some((s) => s.toLowerCase().includes(q)));
}
