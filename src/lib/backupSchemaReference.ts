/**
 * A hand-written reference to the raw backup JSON format (the file the
 * "⬇ Backup" button downloads and "⬆ Restore" accepts), for handing to an
 * outside LLM that's asked to write or edit a backup file directly -- e.g.
 * "add a sell_home event" when the current plan has no sell_home event to
 * copy from. Every enum value and every numeric constraint listed here
 * (`>0`, `>=0`, `0..1`, etc.) is enforced by this app's zod schemas on
 * import; a value outside them fails with a "Too small"/"Invalid enum
 * value"/etc. error and the whole import is rejected.
 *
 * Kept as hand-written prose (not generated from the zod schemas) because
 * the target reader is an LLM, not a type-checker: it needs the *shape*
 * spelled out with realistic example values, not a schema dump. When a
 * domain file's constraints or enums change, update this file to match --
 * there is no automated check that the two stay in sync.
 */
export const BACKUP_SCHEMA_REFERENCE = `# Financial Forecast — Backup File Format Reference

This documents the exact JSON shape the "⬆ Restore" button accepts (the same shape "⬇ Backup" downloads). It's meant for an AI assistant asked to write or edit a backup file directly — for example, adding an event type the current plan has no example of. Every constraint below (\`>0\`, \`>=0\`, an enum's exact allowed values, a 'YYYY-MM-DD' date) is enforced on import; anything outside it fails the whole import with a validation error naming the offending field.

**General rules:**
- All \`id\` fields are non-empty strings. When adding a new entity, invent any unique string (e.g. a short random token) — the app doesn't require a particular format.
- All dates are the string \`"YYYY-MM-DD"\`.
- Every dollar amount in this file is **today's dollars** (as of the plan's start), *not* the amount that will actually occur in a future year — the engine inflates/grows it forward internally using the item's own growth rate.
- A field typed \`number\` **cannot** be \`null\` unless explicitly noted "nullable" below. Where a field says "null = ...", that's the deliberate way to request that default behavior — don't substitute \`0\` for it, they mean different things (e.g. a growth rate of \`null\` tracks inflation; \`0\` is a hard flat 0%, which is not the same when inflation is nonzero).
- Optional fields may be omitted entirely; you don't need to write \`"field": null\` for something with no default unless the spec below says nullable.

## Top-level document

\`\`\`
{
  "id": string,
  "activeScenarioId": string,       // must equal one scenario's id below
  "scenarios": [ Scenario, ... ]    // at least 1
}
\`\`\`

## Scenario

\`\`\`
{
  "id": string,
  "name": string,                   // non-empty
  "description": string,            // optional
  "household": Household,
  "accounts": [ Account, ... ],
  "incomeSources": [ IncomeSource, ... ],
  "expenses": [ ExpenseBaseline, ... ],
  "events": [ Event, ... ],
  "settings": Settings
}
\`\`\`

Every scenario must contain exactly one account with \`"isExtraSavings": true\` — this is the mandatory spending hub. If none is present the app auto-creates a bare one on load, but a hand-written file should include it explicitly so its balance/name are meaningful.

## Household

\`\`\`
{
  "people": [
    {
      "id": string,
      "name": string,               // non-empty
      "birthDate": "YYYY-MM-DD",
      "retirementAge": integer > 0,  // THE retirement setting: the engine reads it (see the note below)
      "retirementDate": "YYYY-MM-DD" | null,           // optional; an exact date, when it isn't the birthday at retirementAge
      "skipRetirement": boolean,                       // optional; true = modelled as working through the whole plan
      "retirementSpending": RetirementSpending | null, // optional; extra spending from the day they retire
      "retirementNotes": string,                       // optional
      "planningEndAge": integer > 0  // the age this person is modelled as living to: sets the plan horizon and drives the survivor rules (income stops, pension survivor share, Social Security survivor keeps the larger benefit, married household files single from the next year)
    },
    ...                              // at least 1 person
  ]
}
\`\`\`

**Retirement lives on the person.** There is no \`retire\` event -- a plan saved by an older build still has one, and loading it folds the event onto its person and drops it (schema version 5 → 6). The retirement date is \`retirementDate\` when set, else the birthday at \`retirementAge\`, and \`skipRetirement: true\` means they never retire. That date is what stops their salary and paycheck contributions, switches their healthcare stage, places the retirement KPIs, and anchors any linked date.

**RetirementSpending:**
\`\`\`
{
  "amount": number >= 0,            // ANNUAL, today's dollars -- posted monthly, not as a December lump
  "growthRatePct": number | null,   // null = track plan inflation
  "paymentAccountId": string | null, // null = pays from Extra Savings
  "endDate": "YYYY-MM-DD" | null,   // null = runs to the end of the plan
  "adjustments": [ TemporaryAdjustment, ... ]  // optional
}
\`\`\`

## Account

\`\`\`
{
  "id": string,
  "name": string,                              // non-empty
  "class": AccountClass,                       // see enum below
  "category": "asset" | "liability",           // MUST match class — see mapping below
  "ownerId": string | null,                    // a person's id, or null = joint/household
  "startingBalance": number,                   // any sign allowed by the schema, but realistically >= 0 for assets
  "startingCostBasis": number >= 0,            // optional; taxable_investment only — omit to assume the whole starting balance is basis (no embedded gains)
  "growthRatePct": number | null,              // nominal annual rate, e.g. 0.07 = 7%/yr; null = track plan inflation rate
  "isExcluded": boolean,                       // optional; true = engine ignores this account entirely
  "isExtraSavings": boolean,                   // optional; true on exactly ONE account per scenario (the spending hub)
  "taxTreatment": "taxable" | "tax_deferred" | "tax_free" | "n/a",  // default "n/a"; leave "n/a" to let the engine infer from class
  "subjectToRMD": boolean,                     // default false; only meaningful for tax_deferred accounts with an ownerId
  "noEarlyWithdrawalPenalty": boolean,         // optional; true = exempt from the 10% under-59½ penalty (72(t)/rule of 55)
  "startDate": "YYYY-MM-DD",                   // optional; account doesn't exist before this date (startingBalance is its value as of this date)
  "balanceCeiling": number >= 0 | null,        // optional; most this account should hold — surplus routing stops here and anything over spills onward. null/omitted = uncapped
  "balanceCeilingGrowthRatePct": number | null,// optional; null = follows plan inflation, keeping the cap a today's-dollars amount
  "balanceFloor": number >= 0 | null,          // optional; shortfall routing won't draw below this. null/omitted = drainable to zero
  "balanceFloorGrowthRatePct": number | null,  // optional; null = follows plan inflation
  "loanTerms": LoanTerms,                      // present ONLY for class credit_card | loan | mortgage
  "propertyGrowthRatePct": number,             // present ONLY for class real_estate; overrides growthRatePct
  "linkedLiabilityId": string,                 // present ONLY for class real_estate; points at its mortgage account's id
  "propertyTaxRatePct": number >= 0,           // optional; real_estate only, e.g. 0.02 = 2%/yr of home value
  "homeInsuranceRatePct": number >= 0,         // optional; real_estate only
  "maintenanceRatePct": number >= 0,           // optional; real_estate only
  "contribution": Contribution | null,         // optional single recurring contribution; ignored if contributionSchedule is set
  "growthRateSchedule": [ GrowthRateScheduleEntry, ... ],     // optional; dated rate overrides
  "contributionSchedule": [ ContributionScheduleSegment, ... ] // optional; supersedes "contribution" entirely when present
}
\`\`\`

**AccountClass enum** (exactly one of): \`"cash"\`, \`"taxable_investment"\`, \`"tax_deferred"\`, \`"tax_free"\`, \`"hsa"\`, \`"education_529"\`, \`"real_estate"\`, \`"other_asset"\`, \`"credit_card"\`, \`"loan"\`, \`"mortgage"\`. An \`hsa\` is paycheck-funded with tax-free withdrawals; an \`education_529\` has tax-free withdrawals.

**category must match class:**
- \`"credit_card"\`, \`"loan"\`, \`"mortgage"\` → \`"category": "liability"\`
- every other class → \`"category": "asset"\`

**LoanTerms** (only on credit_card/loan/mortgage accounts):
\`\`\`
{
  "originalPrincipal": number >= 0,
  "originationDate": "YYYY-MM-DD",
  "annualInterestRatePct": number, 0..1,        // e.g. 0.056 = 5.6%/yr
  "termMonths": integer > 0,
  "monthlyPayment": number >= 0,                 // optional; computed by standard amortization if omitted
  "extraPrincipalMonthly": number >= 0,          // optional; extra principal each month, shortens the term
  "linkedAssetId": string,                       // optional; e.g. a mortgage's linked real_estate account id. A HELOC points at its home this way and is paid off when the home sells
  "interestOnlyMonths": number                   // optional; a line of credit's draw period -- interest-only, balance untouched, then termMonths of repayment
}
\`\`\`

**Contribution** (a single \`contribution\` field, or one segment of \`contributionSchedule\`):
\`\`\`
{
  "amount": number > 0,           // MUST be strictly greater than 0 — to pause a contribution, either omit the schedule segment for that window entirely (leaving a gap = no contribution) or give the prior segment an endDate, do NOT write amount: 0
  "frequency": Frequency,         // see enum below
  "growthRatePct": number | null, // optional; null = track plan inflation
  "payrollDeducted": boolean,     // default false; true = 401k/457/403b-style, no cash outflow (take-home is already net of it); false = Roth IRA/brokerage-style, draws real cash from the spending hub
  "endDate": "YYYY-MM-DD" | null  // optional; omitted = stops automatically at the owner's retirement
}
\`\`\`
\`contributionSchedule\` entries additionally require a \`"startDate": "YYYY-MM-DD"\`. An omitted \`endDate\` on a segment runs until the next segment's \`startDate\`, or indefinitely for the last segment.

**GrowthRateScheduleEntry:**
\`\`\`
{ "startDate": "YYYY-MM-DD", "ratePct": number }   // nominal annual rate from this date, replacing the account's base growthRatePct
\`\`\`

## IncomeSource

\`\`\`
{
  "id": string,
  "name": string,
  "ownerId": string | null,
  "amount": number,                 // per-occurrence, today's dollars. Take-home (net) for everything EXCEPT category social_security/pension, which are entered GROSS (pre-tax) — the engine taxes those itself
  "grossAmount": number,             // optional; category "salary" only — Box-1-style gross wages, used to place withdrawals/gains in the right tax bracket while still working
  "frequency": Frequency,
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD" | null,   // null = continues to plan horizon
  "growthRatePct": number | null,   // null = track plan inflation
  "startAnchor": DateAnchor | null,  // optional; when set, startDate is RECOMPUTED from it on every load and edit
  "endAnchor": DateAnchor | null,    // optional; when set, endDate is recomputed as the DAY BEFORE the anchor point
  "intervalYears": integer > 0,     // optional; repeat every N years instead of "frequency" (e.g. a bonus every 3 years)
  "depositAccountId": string | null, // null = deposits automatically to Extra Savings
  "category": IncomeCategory,        // see enum below
  "adjustments": [ TemporaryAdjustment, ... ],  // optional
  "isExcluded": boolean,             // optional
  "claimAge": number > 0,            // optional; social_security/pension only — the age the benefit starts (informational; startDate is what the engine reads)
  "survivorPct": number, 0..1        // optional; pension only — share that continues to a surviving household member after the owner's planningEndAge; omitted/0 = stops
}
\`\`\`

A pension's \`growthRatePct\` of \`null\` means **0** (no cost-of-living raise), unlike every other category where null tracks inflation.

**IncomeCategory enum:** \`"salary"\`, \`"social_security"\`, \`"pension"\`, \`"rental"\`, \`"other"\`.

## ExpenseBaseline

\`\`\`
{
  "id": string,
  "name": string,
  "amount": number,                  // per-occurrence, today's dollars
  "frequency": Frequency,
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD" | null,
  "growthRatePct": number | null,
  "startAnchor": DateAnchor | null,  // optional; when set, startDate is RECOMPUTED from it on every load and edit
  "endAnchor": DateAnchor | null,    // optional; when set, endDate is recomputed as the DAY BEFORE the anchor point
  "intervalYears": integer > 0,      // optional; e.g. a car replaced every 7 years
  "paymentAccountId": string | null, // null = pays automatically from Extra Savings
  "category": ExpenseCategory,       // see enum below
  "adjustments": [ TemporaryAdjustment, ... ],  // optional
  "isExcluded": boolean              // optional
}
\`\`\`

**ExpenseCategory enum:** \`"housing"\`, \`"transportation"\`, \`"food"\`, \`"healthcare"\`, \`"childcare"\`, \`"discretionary"\`, \`"other"\`.

## DateAnchor

A date that FOLLOWS someone's retirement instead of being typed in. Available on any IncomeSource, ExpenseBaseline, or event. When an anchor is present the corresponding \`startDate\`/\`endDate\` is **derived**: the app recomputes it on every load and every edit, so a hand-written date beside an anchor is ignored (write the anchor's own answer there, or omit the anchor).
\`\`\`
{
  "personId": string,           // whose retirement this follows
  "point": "retirement",        // the only milestone so far
  "offsetMonths": integer       // signed: -24 = two years before, 0 = the day itself, 120 = ten years after
}
\`\`\`

The retirement date itself comes from the person (see Household above): \`retirementDate\` when set, else their birthday at \`retirementAge\`. Someone with \`skipRetirement\` has no date, so an anchor to them resolves to nothing and the stored date stands. An \`endAnchor\` resolves to the day BEFORE that date, because \`endDate\` is inclusive ("ends when I retire" = the last payment is before retirement day).

## Frequency enum

Used by income, expenses, contributions, and custom_transfer events: \`"monthly"\`, \`"biweekly"\`, \`"weekly"\`, \`"annual"\`, \`"one_time"\`.

## TemporaryAdjustment

A scaling window on an income source or expense (raises, career breaks, temporary spending cuts) — not a separate event.
\`\`\`
{
  "id": string,
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD" | null,  // null = runs through end of plan
  "multiplier": number >= 0,        // 0 = fully paused, 0.5 = halved, 1.03 = a one-off 3% bump
  "note": string                    // optional
}
\`\`\`

## Events

Every event shares these base fields, plus a \`"type\"\`-specific set below:
\`\`\`
{
  "id": string,
  "name": string,
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD" | null,   // optional; for temporary effects — omitted/null = permanent
  "startAnchor": DateAnchor | null,  // optional; when set, startDate is RECOMPUTED from it on every load and edit
  "endAnchor": DateAnchor | null,    // optional; when set, endDate is recomputed as the DAY BEFORE the anchor point
  "notes": string,                  // optional
  "isExcluded": boolean,            // optional
  "type": EventType                 // one of the six below — determines which extra fields apply
}
\`\`\`

**type: "buy_home"**
\`\`\`
{
  ...base,
  "type": "buy_home",
  "purchasePrice": number > 0,               // today's dollars; inflated forward to startDate at save time
  "downPaymentAmount": number >= 0,
  "downPaymentFromAccountId": string,        // required
  "realEstateAccountId": string,             // required — the real_estate Account this purchase creates/points at (must exist in "accounts", class "real_estate"; if financed it should have a linked "mortgage" account via linkedLiabilityId)
  "replaceHousingExpenses": boolean          // optional; true = any "housing"-category expense stops the day before this closes
}
\`\`\`

**type: "sell_home"**
\`\`\`
{
  ...base,
  "type": "sell_home",
  "realEstateAccountId": string,             // the real_estate account being sold — required
  "netProceeds": number,                     // required (can be negative — an underwater sale). Ignored if sellingCostsPct is set
  "sellingCostsPct": number | null,          // optional, 0..1; when set, engine computes proceeds itself: simulated home value × (1 − this) − remaining mortgage, and ignores netProceeds
  "proceedsAccountId": string | null         // null = proceeds land in Extra Savings
}
\`\`\`
Selling zeroes out both that home's asset balance and its linked mortgage balance on this date.

**type: "roth_conversion"**
\`\`\`
{
  ...base,
  "type": "roth_conversion",
  "fromAccountId": string,                   // a tax-deferred account
  "toAccountId": string,                     // a tax-free (Roth) account; must differ
  "amount": number > 0 | null,               // today's dollars per occurrence; null when fillToBracketRate is set
  "fillToBracketRate": number | null,        // e.g. 0.12 = each December convert just enough to fill ordinary taxable income to the top of the 12% bracket; null = use amount
  "frequency": "annual" | "one_time",        // default "annual"
  "taxSource": "cash" | "withhold",          // default "cash": tax paid from Extra Savings; "withhold": taken out of the conversion
  "growthRatePct": number | null,            // optional; the fixed amount's yearly growth; null = inflation
  "endDate": "YYYY-MM-DD" | null             // optional; last year for an annual conversion
}
\`\`\`
Ordinary income in the year it happens, never the 10% penalty.

**type: "pay_off_loan"**
\`\`\`
{
  ...base,
  "type": "pay_off_loan",
  "loanAccountId": string,                   // a credit_card / loan / mortgage account
  "fromAccountId": string,                   // the asset account that pays; must differ
  "amount": number > 0 | null                // today's dollars; null = pay off whatever is left on that date
}
\`\`\`

**type: "open_loan"**
\`\`\`
{
  ...base,
  "type": "open_loan",
  "loanAccountId": string,                   // the \`loan\` account this event created and owns
  "loanKind": "fixed" | "heloc",             // default "fixed". A heloc's account carries loanTerms.interestOnlyMonths (draw period) and loanTerms.linkedAssetId (the home)
  "principal": number > 0,                   // today's dollars; inflated forward to startDate (origination)
  "proceedsAccountId": string | null         // where the borrowed cash lands; null = it paid for something the plan doesn't track
}
\`\`\`
Takes a new non-mortgage loan on (a car loan, HELOC, student or personal loan). The \`loan\` account carries the balance, rate and term and amortizes from its own origination date, exactly like a mortgage created by \`buy_home\`; deleting this event deletes that account with it. Borrowing is not income -- when \`proceedsAccountId\` is set the cash is credited as a transfer alongside the matching debt, and when it is null no account ever sees the money.

**type: "rollover"**
\`\`\`
{
  ...base,
  "type": "rollover",
  "fromAccountId": string,                   // a tax-deferred account
  "toAccountId": string,                     // another tax-deferred account; must differ
  "amount": number > 0 | null                // today's dollars; null = the whole balance on that date
}
\`\`\`
Not a taxable event.

**type: "custom_transfer"**
\`\`\`
{
  ...base,
  "type": "custom_transfer",
  "amount": number > 0,                      // MUST be strictly greater than 0
  "fromAccountId": string,                   // required; must differ from toAccountId
  "toAccountId": string,                     // required; must differ from fromAccountId
  "frequency": Frequency,
  "growthRatePct": number | null,            // optional; null = track plan inflation
  "intervalYears": integer > 0               // optional; repeat every N years, overrides frequency
}
\`\`\`
Use this for other moves between two of the household's own accounts on a schedule (e.g. a planned annual transfer to a 529 from a brokerage). Use \`roth_conversion\`, \`rollover\`, and \`pay_off_loan\` for those cases. It is NOT for money entering/leaving the household (that's an income source or expense). Money leaving a taxable or tax-deferred account this way is taxed as a sale or distribution.

## Settings

\`\`\`
{
  "startDate": "YYYY-MM-DD" | null,          // null = today, live (recomputed on every load)
  "horizonEndDate": "YYYY-MM-DD",            // required
  "inflationRatePct": number,                // e.g. 0.03 = 3%/yr
  "moneyFlow": {
    "splitOrder": [ SplitStop, ... ],        // where surplus cash goes, in order
    "drainOrder": [ DrainStop, ... ]         // what covers a shortfall, in order
  },
  "rmdEnabled": boolean,                      // default true
  "filingStatus": "single" | "marriedFilingJointly",   // default "marriedFilingJointly"
  "additionalFlatTaxRatePct": number, 0..1,   // default 0; flat state/local add-on rate
  "withdrawalStrategy": "conventional" | "tax_deferred_first" | "pro_rata" | "custom",
                                              // optional; absent = "custom" when drainOrder has entries, else "conventional".
                                              // A preset derives the drain order from the accounts (cash, then taxable, then
                                              // tax-deferred, then Roth for "conventional"; homes/HSAs/529s never drawn) and
                                              // ignores moneyFlow.drainOrder; "custom" reads moneyFlow.drainOrder as-is.
  "cashBufferTarget": number >= 0 | null,     // default null; today's dollars kept in Extra Savings, topped up by the drain order
  "planReturnRatePct": number | null,         // default null; one nominal return for every investment account while set
  "healthcare": Healthcare                    // optional; every field has a default (see below)
}
\`\`\`

**Healthcare** (the healthcare model; off by default — premiums entered as expenses keep working):
\`\`\`
{
  "enabled": boolean,                                  // default false
  "costGrowthRatePct": number | null,                  // default 0.05; null = plan inflation
  "workingMonthlyPremiumPerPerson": number >= 0,       // default 0 (paycheck premiums are usually already net of take-home)
  "spouseCoverageWhileWorking": boolean,               // default true
  "retiredCoverage": "marketplace" | "cobra_then_marketplace" | "fixed" | "none",   // default "marketplace"
  "fixedMonthlyPremiumPerPerson": number >= 0,         // default 600; used by "fixed"
  "cobra": { "months": integer >= 0, "monthlyPremiumPerPerson": number >= 0 },     // defaults 18, 750
  "marketplace": {
    "benchmarkMonthlyPremiumPerPerson": number >= 0,   // default 650; full price today at the person's current age
    "ageRated": boolean,                               // default true; federal age curve
    "premiumTaxCredit": boolean,                       // default true; credit from the plan's own income each year
    "enhancedSubsidies": boolean                       // default false; the 2021-2025 schedule
  },
  "medicare": {
    "partDMonthlyPremium": number >= 0,                // default 45
    "supplementMonthlyPremium": number >= 0,           // default 150
    "irmaa": boolean                                   // default true; surcharges from income two years back
  },
  "outOfPocket": {
    "preMedicareAnnualPerPerson": number >= 0,         // default 2000
    "medicareAnnualPerPerson": number >= 0,            // default 2500
    "payFromHsa": boolean                              // default true
  }
}
\`\`\`
All money is today's dollars (per person per month unless the name says otherwise) and grows at \`costGrowthRatePct\`. Part B's standard premium and the IRMAA and premium-credit tables are built in (2026 figures).

**SplitStop** (surplus routing — cascading, each stop offered in list order):
\`\`\`
{
  "id": string,
  "accountId": string,
  "kind": "flat" | "percent_of_remainder",   // default "percent_of_remainder"
  "amount": number >= 0 | null,               // used when kind = "flat"; today's dollars, grown by inflation
  "pct": number | null, 0..1,                 // used when kind = "percent_of_remainder"; share of what's left after stops above it (NOT a share of the original total)
  "limitAmount": number >= 0 | null,          // most this stop may route per limitPeriod; null/omitted = unlimited
  "limitPeriod": "monthly" | "quarterly" | "annual",  // omitted = "annual"; ignored when limitAmount is null
  "limitGrowthRatePct": number | null,        // null = follows plan inflation
  "startDate": "YYYY-MM-DD" | null,           // null = active from plan start
  "endDate": "YYYY-MM-DD" | null,             // null = active through plan end
  "maxBalance": null,                         // DEPRECATED -- use the target account's balanceCeiling; a legacy value here is migrated onto the account on load
  "maxBalanceGrowthRatePct": null             // DEPRECATED -- see maxBalance
}
\`\`\`

**DrainStop** (shortfall routing — same cascading model):
\`\`\`
{
  "id": string,
  "accountId": string,
  "kind": "flat" | "percent_of_remainder",
  "amount": number >= 0 | null,
  "pct": number | null, 0..1,                 // defaults to 1 if omitted (drain this stop fully before the next)
  "limitAmount": number >= 0 | null,          // most this stop may draw per limitPeriod; null/omitted = unlimited
  "limitPeriod": "monthly" | "quarterly" | "annual",  // omitted = "annual"; ignored when limitAmount is null
  "limitGrowthRatePct": number | null,        // null = follows plan inflation
  "startDate": "YYYY-MM-DD" | null,
  "endDate": "YYYY-MM-DD" | null,
  "minBalance": null,                         // DEPRECATED -- use the source account's balanceFloor; a legacy value here is migrated onto the account on load
  "minBalanceGrowthRatePct": null             // DEPRECATED -- see minBalance
}
\`\`\`
The same accountId may appear in multiple drain stops with different date windows (e.g. drain account A, then B, then back to A).

**Balance bounds vs. rate limits.** A stop's \`limitAmount\` bounds the FLOW through that rule per period (e.g. \`$7,000/year\` of contribution room, or \`$40,000/year\` of drawdown to manage realized gains). An account's \`balanceCeiling\`/\`balanceFloor\` bound the resulting BALANCE, and apply however the money arrived or left. Both are enforced, whichever binds first — a rate limit can't see the balance, so on its own it will drain straight through a floor.

## Values that commonly trip up a hand-written file

- \`amount\` on a \`Contribution\`, \`ContributionScheduleSegment\`, and a \`custom_transfer\` event **must be > 0** — never 0. To represent "paused," leave a gap in a contribution schedule (no segment covering that window) instead of inserting a zero-amount segment.
- \`purchasePrice\` (buy_home) also must be **> 0**.
- Every \`growthRatePct\`-style field is nominal (already includes inflation) and accepts \`null\` to mean "track the plan's inflation rate" — don't use \`0\` for that; \`0\` is a real, different assumption (flat in nominal dollars, i.e. shrinking in real terms whenever inflation is nonzero).
- \`category\` on an Account must match \`class\` per the mapping above, or the whole scenario fails to parse.
- Dates are always the string \`"YYYY-MM-DD"\`, never a Date object or a Unix timestamp.
- \`activeScenarioId\` must be the \`id\` of one of the scenarios in the \`scenarios\` array.
- A \`custom_transfer\` event's \`fromAccountId\` and \`toAccountId\` must be different accounts.
`;
