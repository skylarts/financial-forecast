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
      "retirementAge": integer > 0,
      "planningEndAge": integer > 0  // sets how far the plan projects for this person
    },
    ...                              // at least 1 person
  ]
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

**AccountClass enum** (exactly one of): \`"cash"\`, \`"taxable_investment"\`, \`"tax_deferred"\`, \`"tax_free"\`, \`"real_estate"\`, \`"other_asset"\`, \`"credit_card"\`, \`"loan"\`, \`"mortgage"\`.

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
  "linkedAssetId": string                        // optional; e.g. a mortgage's linked real_estate account id
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
  "intervalYears": integer > 0,     // optional; repeat every N years instead of "frequency" (e.g. a bonus every 3 years)
  "depositAccountId": string | null, // null = deposits automatically to Extra Savings
  "category": IncomeCategory,        // see enum below
  "adjustments": [ TemporaryAdjustment, ... ],  // optional
  "isExcluded": boolean              // optional
}
\`\`\`

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
  "intervalYears": integer > 0,      // optional; e.g. a car replaced every 7 years
  "paymentAccountId": string | null, // null = pays automatically from Extra Savings
  "category": ExpenseCategory,       // see enum below
  "adjustments": [ TemporaryAdjustment, ... ],  // optional
  "isExcluded": boolean              // optional
}
\`\`\`

**ExpenseCategory enum:** \`"housing"\`, \`"transportation"\`, \`"food"\`, \`"healthcare"\`, \`"childcare"\`, \`"discretionary"\`, \`"other"\`.

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
  "notes": string,                  // optional
  "isExcluded": boolean,            // optional
  "type": EventType                 // one of the five below — determines which extra fields apply
}
\`\`\`

**type: "retire"**
\`\`\`
{
  ...base,
  "type": "retire",
  "personId": string,                       // whose retirement this is
  "retirementAge": integer > 0,              // optional; overrides that person's Household.retirementAge
  "retirementExpense": {                     // optional; extra spending starting the day retirement begins
    "amount": number >= 0,                    // annual, today's dollars
    "growthRatePct": number | null,
    "paymentAccountId": string | null,        // null = pays from Extra Savings
    "endDate": "YYYY-MM-DD" | null,           // null = runs to end of plan
    "adjustments": [ TemporaryAdjustment, ... ]  // optional
  } | null
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

**type: "have_a_kid"**
\`\`\`
{
  ...base,
  "type": "have_a_kid",
  "childcareMonthlyExpense": number >= 0,
  "childcareEndDate": "YYYY-MM-DD" | null,   // required key, nullable value
  "additionalOneTimeCost": number >= 0,      // optional; e.g. a one-time hospital/adoption cost
  "paymentAccountId": string                 // required — which account childcare/one-time costs draw from
}
\`\`\`

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
Use this for anything that moves money between two of the household's own accounts on a schedule — a Roth conversion ladder (traditional → Roth), a planned annual transfer to a 529, etc. It is NOT for money entering/leaving the household (that's an income source or expense).

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
  "additionalFlatTaxRatePct": number, 0..1    // default 0; flat state/local add-on rate
}
\`\`\`

**SplitStop** (surplus routing — cascading, each stop offered in list order):
\`\`\`
{
  "id": string,
  "accountId": string,
  "kind": "flat" | "percent_of_remainder",   // default "percent_of_remainder"
  "amount": number >= 0 | null,               // used when kind = "flat"; today's dollars, grown by inflation
  "pct": number | null, 0..1,                 // used when kind = "percent_of_remainder"; share of what's left after stops above it (NOT a share of the original total)
  "maxBalance": number >= 0 | null,           // ceiling on the target account; null = uncapped (a catch-all)
  "maxBalanceGrowthRatePct": number | null,   // null = follows plan inflation
  "startDate": "YYYY-MM-DD" | null,           // null = active from plan start
  "endDate": "YYYY-MM-DD" | null              // null = active through plan end
}
\`\`\`

**DrainStop** (shortfall routing — same cascading model, plus a floor):
\`\`\`
{
  "id": string,
  "accountId": string,
  "kind": "flat" | "percent_of_remainder",
  "amount": number >= 0 | null,
  "pct": number | null, 0..1,                 // defaults to 1 if omitted (drain this stop fully before the next)
  "startDate": "YYYY-MM-DD" | null,
  "endDate": "YYYY-MM-DD" | null,
  "minBalance": number >= 0 | null,           // floor this stop won't be drained below; null = no floor
  "minBalanceGrowthRatePct": number | null    // null = follows plan inflation
}
\`\`\`
The same accountId may appear in multiple drain stops with different date windows (e.g. drain account A, then B, then back to A).

## Values that commonly trip up a hand-written file

- \`amount\` on a \`Contribution\`, \`ContributionScheduleSegment\`, and a \`custom_transfer\` event **must be > 0** — never 0. To represent "paused," leave a gap in a contribution schedule (no segment covering that window) instead of inserting a zero-amount segment.
- \`purchasePrice\` (buy_home) also must be **> 0**.
- Every \`growthRatePct\`-style field is nominal (already includes inflation) and accepts \`null\` to mean "track the plan's inflation rate" — don't use \`0\` for that; \`0\` is a real, different assumption (flat in nominal dollars, i.e. shrinking in real terms whenever inflation is nonzero).
- \`category\` on an Account must match \`class\` per the mapping above, or the whole scenario fails to parse.
- Dates are always the string \`"YYYY-MM-DD"\`, never a Date object or a Unix timestamp.
- \`activeScenarioId\` must be the \`id\` of one of the scenarios in the \`scenarios\` array.
- A \`custom_transfer\` event's \`fromAccountId\` and \`toAccountId\` must be different accounts.
`;
