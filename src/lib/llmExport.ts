import type {
  Account,
  DrainStop,
  ExpenseBaseline,
  IncomeSource,
  SplitStop,
  Scenario,
  ScenarioEvent,
  TemporaryAdjustment,
} from "@/domain";
import { projectScenario } from "@/engine/forecastScenario";
import { formatMoney } from "@/lib/format";

const PREAMBLE = `This is a Markdown export of one scenario from a personal retirement/financial forecasting app, for discussion with an AI assistant. It is not financial advice, and no assumptions here are guaranteed to be accurate.

**How to use this document.** It contains everything needed to reason about the plan: a glossary of the app's terms, a description of how the forecast engine actually computes the numbers, the complete set of user-editable inputs, and the resulting projection. When answering questions or suggesting changes, work from the engine's real mechanics described below rather than from generic financial-planning heuristics — this model has specific rules (deterministic, no Monte Carlo; nominal growth rates; a routing waterfall; exact bracket-based tax) that determine which inputs actually move the outcome. The "Levers" section at the end lists every input the user can change.`;

const GLOSSARY = `## Glossary

- **Take-home / net income**: every income source's \`amount\` in this export (except Social Security and pension, see below) is already **net of taxes and payroll deductions** — the actual cash that lands in an account.
- **Social Security & pension are gross**: these two income categories are entered as their **gross** (pre-tax) amount. The engine computes tax on them itself (Social Security is only partly taxable, per IRS rules); don't treat their listed amount as take-home cash.
- **Account \`class\`**: the type of account — \`cash\`, \`taxable_investment\`, \`tax_deferred\` (traditional 401k/IRA), \`tax_free\` (Roth), \`real_estate\`, \`other_asset\`, \`credit_card\`, \`loan\`, or \`mortgage\`. Anything in \`credit_card\`/\`loan\`/\`mortgage\` is a liability; everything else is an asset.
- **Account \`taxTreatment\`**: how withdrawals/growth are taxed — \`taxable\` (brokerage/savings), \`tax_deferred\` (pay ordinary income tax on withdrawal, e.g. traditional 401k/IRA), \`tax_free\` (Roth — no tax on qualified withdrawals), or \`n/a\` (real estate, loans, etc.). When left at \`n/a\`, the engine infers the treatment from the class, so a brokerage/traditional/Roth account is still taxed correctly.
- **Routing (Extra Savings / split order / drain order)**: money doesn't move between accounts arbitrarily. Exactly one account per scenario is flagged \`isExtraSavings\` — it's the mandatory spending hub: income deposits there, expenses pay from there, and it has no user-configurable floor or ceiling of its own. Each month it captures whatever net income-minus-expenses landed on it (the "fresh surplus"), and the **split order** (an ordered list of accounts, each a flat dollar amount or a cascading percentage of what's left after the stops above it, plus an optional balance cap) decides where that surplus goes; whatever the list doesn't claim simply stays in Extra Savings. When Extra Savings' balance would go below $0, the shortfall is covered by the **drain order** (an ordered list of accounts drawn down to cover the gap, e.g. selling investments to cover a deficit).
- **Nominal vs. real dollars**: "nominal" = actual future dollar amounts (what your account statement will literally say). "real" = nominal amounts deflated back to today's purchasing power using the plan's inflation rate, so you can compare a dollar in 2050 to a dollar today.
- **Growth rates are nominal**: every \`growthRatePct\` in this export (accounts, income, expenses, contributions) is a **nominal** annual rate that already includes inflation. A 0% growth rate means flat in *nominal* terms — i.e. shrinking in real terms. It is not an inflation-adjusted "real" return.
- **Federal tax**: this export's federal tax figures are the plan's **exact annual bracket bill** for that year — computed from the real IRS bracket tables for the filing status below, not a flat estimate.
- **\`isExcluded\`**: an input flagged excluded is still stored and visible in the app, but the engine skips it entirely — no growth, no cash flows, no effect on net worth or KPIs. It's a "what if this didn't exist" toggle.
- **Adjustment**: a temporary multiplier window on an income source or expense (0 = fully paused, 0.5 = halved, 1.03 = a 3% bump) over a date range. This is how raises, career breaks, and temporary spending changes are modeled — not as separate events.
`;

const ENGINE_MODEL = `## How the Forecast Engine Works

Understanding these mechanics is what makes a suggestion accurate rather than generic. The engine is a **deterministic month-by-month simulation** — there is no Monte Carlo, no return volatility, and no sequence-of-returns risk. Every account grows at exactly its stated rate every month. A projection is therefore a single arithmetic path, not a probability distribution: don't describe outcomes as "likely" or quote success probabilities, and don't suggest changes whose only benefit would be reducing volatility, because this model has none.

Each month, in this exact order:

1. **Growth.** Every non-excluded asset account grows by its annual rate converted to a monthly rate. Liabilities (credit card / loan / mortgage) do not grow this way — they amortize in step 3. An account gets no growth in the month it's created.
2. **Scheduled cash flows.** Income posts to its deposit account; expenses pay from their payment account; contributions post into their target account. Social Security and pension have estimated tax withheld here (they're the only gross-entered income).
3. **Loan & mortgage amortization.** Each loan's monthly payment is split into interest and principal; the principal reduces the loan balance and the full payment is drawn from the paying account.
4. **RMDs.** Every January, for accounts flagged \`subjectToRMD\`, the prior Dec-31 balance divided by the IRS life-expectancy divisor for the owner's age is forced out, taxed, and deposited to Extra Savings. Roth accounts are never subject to RMDs.
5. **Surplus split (Extra Savings).** Extra Savings' "fresh surplus" for the month is exactly what steps 1–4 added to its balance THIS month — not its whole running balance, so money left unclaimed in a prior month (a deliberate reserve) is never re-offered to the split. Each split-order stop, in list order, is offered either a flat dollar amount or a percentage of what's left after the stops above it (cascading — not a share of the original total), clamped by its own optional balance cap; whatever the whole list doesn't claim stays in Extra Savings.
6. **Cap overflow rebalance.** Any split stop sitting above its cap (from growth, or money that landed in it directly) pushes the excess down to later stops with room. This is a transfer between the user's own accounts, so it doesn't count as routed surplus, but selling out of a taxable account still realizes tax.
7. **Deficit cascade (the drain order).** If Extra Savings' balance would drop below $0, the shortfall is pulled from the drain order — in list order for \`priority_fill\`, or by configured share for \`fixed_split\`. Only stops whose date window covers the month participate, and no stop is drawn below its minimum-balance floor. Each draw is sized so the withdrawal *plus its own tax* fits in what's available.

**Taxes.** Any dollar leaving a \`tax_deferred\` account is taxed as ordinary income in full. Any dollar leaving a \`taxable\` account is taxed only on its realized-gain portion, using **average-cost basis**: basis is the starting balance plus every dollar of new money added since (contributions, routed surplus, transfers); growth never adds basis. \`tax_free\` (Roth) and cash withdrawals realize no tax. The tax on a withdrawal is deducted from the same account it came out of.

At year-end the engine computes the **exact** federal bill from real IRS bracket tables (brackets and the standard deduction are inflation-indexed forward from 2026): ordinary income = gross tax-deferred withdrawals + gross pension + the taxable portion of Social Security (per the IRS partial-inclusion rule), less the standard deduction; long-term capital gains are stacked on top of ordinary income in the LTCG brackets. The optional flat add-on rate is applied to the same combined base to approximate state/local tax. Because tax during the monthly loop depends on rates that depend on the year's income, the whole simulation is re-run a few times until each year's marginal-rate estimate converges on its actual result.

**What this implies for suggestions.** Withdrawal ordering (the drain order) drives the lifetime tax bill, because it determines which accounts' gains and ordinary income get realized in which years and at which marginal rates. Buffers and caps control how much cash sits idle versus invested. Growth rates, inflation, and the contribution schedule dominate accumulation. Excluding an item is the cheapest way to test its impact.`;

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function section(title: string): string {
  return `\n## ${title}\n`;
}

/** "$500 per monthly" reads badly; "$500 monthly" / "$500 once" reads correctly. */
function fmtRecurrence(amount: number, frequency: string, intervalYears?: number): string {
  const money = formatMoney(amount);
  if (intervalYears) {
    return `${money} every ${intervalYears === 1 ? "year" : `${intervalYears} years`}`;
  }
  if (frequency === "one_time") return `${money} once`;
  return `${money} ${frequency}`;
}

function fmtGrowth(rate: number | undefined): string {
  if (!rate) return "flat in nominal terms (0% growth)";
  return `growing ${fmtPct(rate)}/yr (nominal)`;
}

function fmtAdjustments(adjustments: TemporaryAdjustment[] | undefined): string[] {
  if (!adjustments?.length) return [];
  return adjustments.map((adj) => {
    const window = `${adj.startDate} → ${adj.endDate ?? "end of plan"}`;
    const effect =
      adj.multiplier === 0
        ? "fully paused"
        : `scaled to ${fmtPct(adj.multiplier)} of the base amount`;
    return `  - Adjustment: ${window} — ${effect}${adj.note ? ` (${adj.note})` : ""}`;
  });
}

export function buildLlmExport(scenario: Scenario): string {
  const lines: string[] = [];

  const personName = (id: string | null | undefined) =>
    id ? scenario.household.people.find((p) => p.id === id)?.name ?? id : "Joint";
  const accountName = (id: string | null | undefined) =>
    id ? scenario.accounts.find((a) => a.id === id)?.name ?? id : "unassigned";

  lines.push(`# Financial Forecast Export — "${scenario.name}"`);
  lines.push("");
  if (scenario.description) {
    lines.push(`_${scenario.description}_`);
    lines.push("");
  }
  lines.push(PREAMBLE);
  lines.push("");
  lines.push(GLOSSARY);
  lines.push("");
  lines.push(ENGINE_MODEL);

  lines.push(section("Household"));
  for (const p of scenario.household.people) {
    lines.push(
      `- **${p.name}** (id: \`${p.id}\`) — born ${p.birthDate}, plans to retire at age ${p.retirementAge}, plan horizon runs through age ${p.planningEndAge}.`
    );
  }

  lines.push(section("Settings"));
  const s = scenario.settings;
  lines.push(`- Plan start date: ${s.startDate}`);
  lines.push(`- Plan horizon end date: ${s.horizonEndDate}`);
  lines.push(`- Inflation rate (annual): ${fmtPct(s.inflationRatePct)}`);
  lines.push(`- Filing status: ${s.filingStatus}`);
  lines.push(`- RMDs enabled: ${s.rmdEnabled ? "yes" : "no"}`);
  lines.push(
    `- Additional flat state/local tax add-on: ${fmtPct(s.additionalFlatTaxRatePct)}${
      s.additionalFlatTaxRatePct === 0 ? " (none — e.g. correct as-is in a no-income-tax state)" : ""
    }`
  );

  // Routing is the single biggest driver of both the tax bill and which
  // accounts survive to the end of the plan, so spell out every stop rather
  // than summarizing it as counts.
  lines.push(section("Money Flow / Routing"));
  const mf = s.moneyFlow;
  const extraSavings = scenario.accounts.find((a) => a.isExtraSavings);
  lines.push(`### Extra Savings (income lands here, expenses pay from here)`);
  if (!extraSavings) {
    lines.push("- No account is flagged `isExtraSavings`. Every scenario should have exactly one — this is almost certainly a misconfiguration.");
  } else {
    lines.push(
      `- **${extraSavings.name}** — the one mandatory spending account. No user-configurable floor or ceiling; its deficit-trigger floor is hardcoded at $0. Each month's "fresh surplus" (what steps 1-4 added to its balance THIS month, not its running total) is offered to the split order below; anything unclaimed simply stays here and keeps accumulating.`
    );
  }

  lines.push("");
  lines.push(`### Split order (where surplus cash goes)`);
  lines.push(
    "Each stop, in list order, is offered either a flat dollar amount or a percentage of what's left after the stops above it (cascading — not a share of the original total), then clamped by its own optional balance cap; the overflow spills to the next stop."
  );
  if (mf.splitOrder.length === 0) {
    lines.push("- None configured — surplus cash simply accumulates in Extra Savings.");
  } else {
    mf.splitOrder.forEach((stop: SplitStop, i) => {
      const parts: string[] = [];
      parts.push(
        stop.kind === "flat"
          ? `flat ${stop.amount == null ? "unset (receives nothing)" : formatMoney(stop.amount)} (today's dollars, grown by inflation)`
          : `${stop.pct == null ? "unset (receives nothing)" : fmtPct(stop.pct)} of what's left after the stops above it`
      );
      if (stop.maxBalance == null) {
        parts.push("uncapped (catch-all — absorbs everything offered to it)");
      } else {
        const capGrowth =
          stop.maxBalanceGrowthRatePct == null
            ? `growing with inflation (${fmtPct(s.inflationRatePct)}/yr)`
            : `growing ${fmtPct(stop.maxBalanceGrowthRatePct)}/yr`;
        parts.push(`capped at ${formatMoney(stop.maxBalance)}, ${capGrowth}`);
      }
      if (stop.startDate || stop.endDate) {
        parts.push(`active ${stop.startDate ?? "plan start"} → ${stop.endDate ?? "plan end"}`);
      } else {
        parts.push("active for the whole plan");
      }
      lines.push(`${i + 1}. **${accountName(stop.accountId)}** — ${parts.join("; ")}.`);
    });
  }

  lines.push("");
  lines.push(`### Drain order (what's sold to cover a shortfall), mode: \`${mf.drainSplitMode}\``);
  lines.push(
    mf.drainSplitMode === "fixed_split"
      ? "Each active stop covers its configured share of the shortfall; any remainder is topped up from the active stops in list order."
      : "Each active stop is drained fully (down to its floor) before the next one is touched."
  );
  lines.push(
    "This order determines which accounts' gains and ordinary income are realized in which years, so it is the primary lever on the lifetime tax bill."
  );
  if (mf.drainOrder.length === 0) {
    lines.push("- None configured — an Extra Savings shortfall cannot be covered and the account will simply run negative (raising an insufficient-funds warning).");
  } else {
    mf.drainOrder.forEach((stop: DrainStop, i) => {
      const parts: string[] = [];
      const account = scenario.accounts.find((a) => a.id === stop.accountId);
      if (account) parts.push(`${account.class} / ${account.taxTreatment}`);
      if (stop.startDate || stop.endDate) {
        parts.push(`active ${stop.startDate ?? "plan start"} → ${stop.endDate ?? "plan end"}`);
      } else {
        parts.push("active for the whole plan");
      }
      if (stop.minBalance != null) {
        const floorGrowth =
          stop.minBalanceGrowthRatePct == null
            ? `inflation (${fmtPct(s.inflationRatePct)}/yr)`
            : `${fmtPct(stop.minBalanceGrowthRatePct)}/yr`;
        parts.push(`never drained below ${formatMoney(stop.minBalance)} (today's dollars, grown by ${floorGrowth})`);
      }
      if (mf.drainSplitMode === "fixed_split") {
        parts.push(`share of shortfall: ${stop.splitPct == null ? "unset" : fmtPct(stop.splitPct)}`);
      }
      lines.push(`${i + 1}. **${accountName(stop.accountId)}** — ${parts.join("; ")}.`);
    });
  }

  lines.push(section("Accounts"));
  for (const a of scenario.accounts as Account[]) {
    lines.push(
      `- **${a.name}** (id: \`${a.id}\`) — class: ${a.class} (${a.category}), tax treatment: ${a.taxTreatment}, owner: ${personName(a.ownerId)}, starting balance: ${formatMoney(a.startingBalance)}, growth rate: ${fmtPct(a.growthRatePct)}/yr nominal${a.subjectToRMD ? ", subject to RMDs" : ""}${a.isExtraSavings ? " — **this is the mandatory Extra Savings account** (see Money Flow / Routing above)" : ""}${a.isExcluded ? " — **excluded from the plan** (engine skips it entirely)" : ""}`
    );
    if (a.propertyGrowthRatePct !== undefined) {
      lines.push(`  - Property growth rate: ${fmtPct(a.propertyGrowthRatePct)}/yr (overrides the growth rate above).`);
    }
    if (a.growthRateSchedule?.length) {
      lines.push(
        `  - Growth-rate schedule (the rate above applies until the first entry starts): ${a.growthRateSchedule
          .map((e) => `${fmtPct(e.ratePct)} from ${e.startDate}`)
          .join(", ")}.`
      );
    }
    if (a.contributionSchedule?.length) {
      lines.push(`  - Contribution schedule (supersedes any single contribution):`);
      for (const seg of a.contributionSchedule) {
        lines.push(
          `    - ${seg.startDate} → ${seg.endDate ?? "next segment / end of plan"}: ${fmtRecurrence(seg.amount, seg.frequency)}, ${fmtGrowth(seg.growthRatePct)}, ${seg.payrollDeducted ? "payroll-deducted (no cash outflow — take-home income is already net of it)" : "funded from the spending hub (a real cash outflow)"}`
        );
      }
    } else if (a.contribution) {
      lines.push(
        `  - Contribution: ${fmtRecurrence(a.contribution.amount, a.contribution.frequency)}, ${fmtGrowth(a.contribution.growthRatePct)}, ${a.contribution.payrollDeducted ? "payroll-deducted (no cash outflow — take-home income is already net of it)" : "funded from the spending hub (a real cash outflow)"}, stops ${a.contribution.endDate ?? "automatically at the owner's retirement"}.`
      );
    }
    if (a.loanTerms) {
      lines.push(
        `  - Loan terms: original principal ${formatMoney(a.loanTerms.originalPrincipal)}, originated ${a.loanTerms.originationDate}, rate ${fmtPct(a.loanTerms.annualInterestRatePct)}, term ${a.loanTerms.termMonths} months${a.loanTerms.monthlyPayment ? `, payment ${formatMoney(a.loanTerms.monthlyPayment)}/mo` : " (payment computed by standard amortization)"}${a.loanTerms.extraPrincipalMonthly ? `, plus ${formatMoney(a.loanTerms.extraPrincipalMonthly)}/mo extra principal` : ""}${a.loanTerms.linkedAssetId ? `, secured by ${accountName(a.loanTerms.linkedAssetId)}` : ""}.`
      );
    }
    if (a.linkedLiabilityId) {
      lines.push(`  - Linked liability: ${accountName(a.linkedLiabilityId)}.`);
    }
    if (a.class === "real_estate") {
      const ownership = [
        a.propertyTaxRatePct ? `property tax ${fmtPct(a.propertyTaxRatePct)}/yr of value` : null,
        a.homeInsuranceRatePct ? `insurance ${fmtPct(a.homeInsuranceRatePct)}/yr of value` : null,
        a.maintenanceRatePct ? `maintenance ${fmtPct(a.maintenanceRatePct)}/yr of value` : null,
      ].filter(Boolean);
      if (ownership.length) lines.push(`  - Ongoing costs: ${ownership.join(", ")}.`);
    }
  }

  lines.push(section("Income Sources"));
  if (scenario.incomeSources.length === 0) {
    lines.push("- None.");
  }
  for (const inc of scenario.incomeSources as IncomeSource[]) {
    const gross = inc.category === "social_security" || inc.category === "pension";
    lines.push(
      `- **${inc.name}** (id: \`${inc.id}\`, category: ${inc.category}) — ${fmtRecurrence(inc.amount, inc.frequency, inc.intervalYears)} ${gross ? "**gross (pre-tax)**" : "take-home (net of tax)"}, ${fmtGrowth(inc.growthRatePct)}, owner: ${personName(inc.ownerId)}, deposits to ${accountName(inc.depositAccountId)}, ${inc.startDate} → ${inc.endDate ?? "end of plan"}${inc.isExcluded ? " — **excluded**" : ""}`
    );
    lines.push(...fmtAdjustments(inc.adjustments));
  }

  lines.push(section("Expenses"));
  if (scenario.expenses.length === 0) {
    lines.push("- None.");
  }
  for (const exp of scenario.expenses as ExpenseBaseline[]) {
    lines.push(
      `- **${exp.name}** (id: \`${exp.id}\`, category: ${exp.category}) — ${fmtRecurrence(exp.amount, exp.frequency, exp.intervalYears)}, ${fmtGrowth(exp.growthRatePct)}, paid from ${accountName(exp.paymentAccountId)}, ${exp.startDate} → ${exp.endDate ?? "end of plan"}${exp.isExcluded ? " — **excluded**" : ""}`
    );
    lines.push(...fmtAdjustments(exp.adjustments));
  }

  lines.push(section("Events"));
  if (scenario.events.length === 0) {
    lines.push("- None.");
  } else {
    for (const ev of scenario.events as ScenarioEvent[]) {
      const suffix = ev.isExcluded ? " — **excluded**" : "";
      const head = `- **${ev.name}** (${ev.type}) — ${ev.startDate}${ev.endDate ? ` → ${ev.endDate}` : ""}${suffix}`;
      lines.push(head);
      switch (ev.type) {
        case "retire":
          lines.push(
            `  - ${personName(ev.personId)} retires${ev.retirementAge ? ` at age ${ev.retirementAge} (overriding their profile's retirement age)` : ""}. Payroll-deducted contributions stop here automatically.`
          );
          if (ev.retirementExpense) {
            lines.push(
              `  - Retirement expense: ${formatMoney(ev.retirementExpense.amount)}/yr from ${accountName(ev.retirementExpense.paymentAccountId)}, growing ${fmtPct(ev.retirementExpense.growthRatePct)}/yr${ev.retirementExpense.endDate ? ` through ${ev.retirementExpense.endDate}` : ""}.`
            );
          }
          break;
        case "buy_home": {
          const financing = ev.mortgage
            ? `Down payment ${formatMoney(ev.downPaymentAmount)} from ${accountName(ev.downPaymentFromAccountId)}. Mortgage: ${fmtPct(ev.mortgage.annualInterestRatePct)} over ${ev.mortgage.termMonths} months${ev.mortgage.extraPrincipalMonthly ? `, plus ${formatMoney(ev.mortgage.extraPrincipalMonthly)}/mo extra principal` : ""}.`
            : `Paid in cash from ${accountName(ev.downPaymentFromAccountId)} — no mortgage created.`;
          const ownership = [
            ev.propertyTaxRatePct ? `property tax ${fmtPct(ev.propertyTaxRatePct)}/yr of value` : null,
            ev.homeInsuranceRatePct ? `insurance ${fmtPct(ev.homeInsuranceRatePct)}/yr of value` : null,
            ev.maintenanceRatePct ? `maintenance ${fmtPct(ev.maintenanceRatePct)}/yr of value` : null,
          ].filter(Boolean);
          lines.push(
            `  - Purchase price ${formatMoney(ev.purchasePrice)}, property grows ${fmtPct(ev.propertyGrowthRatePct)}/yr. ${financing}${ownership.length ? ` Ongoing: ${ownership.join(", ")}.` : ""}${ev.replaceHousingExpenses ? " Replaces any existing 'Housing' category expense as of this purchase date." : ""}`
          );
          break;
        }
        case "have_a_kid":
          lines.push(
            `  - Childcare ${formatMoney(ev.childcareMonthlyExpense)}/mo until ${ev.childcareEndDate ?? "end of plan"}${ev.additionalOneTimeCost ? `, plus a one-time ${formatMoney(ev.additionalOneTimeCost)}` : ""}, paid from ${accountName(ev.paymentAccountId)}.`
          );
          break;
        case "custom_transfer":
          lines.push(
            `  - ${fmtRecurrence(ev.amount, ev.frequency, ev.intervalYears)} from ${accountName(ev.fromAccountId)} to ${accountName(ev.toAccountId)}${ev.growthRatePct ? `, ${fmtGrowth(ev.growthRatePct)}` : ""}.`
          );
          break;
      }
      if (ev.notes) lines.push(`  - Notes: ${ev.notes}`);
    }
  }

  try {
    const projection = projectScenario(scenario);
    const k = projection.kpis;
    lines.push(section("Projected Summary (KPIs)"));
    lines.push(`- Net worth at end of year 1: ${formatMoney(k.netWorthEndOfYear1)} (real: ${formatMoney(k.netWorthEndOfYear1Real)})`);
    if (k.netWorthAtRetirement !== null) {
      lines.push(
        `- Net worth at retirement (age ${k.retirementAge}): ${formatMoney(k.netWorthAtRetirement)} (real: ${formatMoney(k.netWorthAtRetirementReal ?? 0)})`
      );
    }
    lines.push(`- Net worth at end of plan: ${formatMoney(k.netWorthAtEnd)} (real: ${formatMoney(k.netWorthAtEndReal)})`);

    if (projection.warnings.length > 0) {
      lines.push(section("Warnings Raised During Projection"));
      lines.push("These are the engine's own diagnostics and usually point straight at the input that needs changing.");
      for (const w of projection.warnings) {
        lines.push(`- **${w.year}** (${w.kind}): ${w.message}`);
      }
    }

    lines.push(section("Year-by-Year Projection"));
    lines.push(
      "All figures are nominal (future dollars) except the last column. Income is take-home plus gross Social Security/pension; Surplus routed is cash swept from the hub(s) into the fill order; Withdrawals is net cash pulled from accounts to cover the gap (including RMD proceeds); Ending cash is the hub balance only, not every cash account."
    );
    lines.push("");
    lines.push(
      "**Reading the Federal tax column:** it covers only the tax this model computes itself — on tax-deferred withdrawals and RMDs, pension, the taxable portion of Social Security, and realized capital gains. Tax on salary is **not** included, because salary is entered take-home (already net of it). A $0 in a working year therefore means \"no tax beyond what's already deducted from the paycheck\", not \"no tax owed\" — so don't read the jump at retirement as a new tax burden appearing, and don't suggest changes premised on those early years being untaxed."
    );
    lines.push("");
    lines.push("| Year | Income | Expenses | Federal tax | Surplus routed | Withdrawals | RMDs | Ending cash | Assets | Liabilities | Net worth | Net worth (real) |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const y of projection.years) {
      const cf = y.cashFlow;
      lines.push(
        `| ${y.year} | ${formatMoney(cf.totalIncome)} | ${formatMoney(cf.totalExpenses)} | ${formatMoney(cf.federalTaxTotal)} | ${formatMoney(cf.surplusRouted)} | ${formatMoney(cf.withdrawalsToCashNet)} | ${formatMoney(cf.rmdTotal)} | ${formatMoney(cf.endingCashBalance)} | ${formatMoney(y.totalAssetsNominal)} | ${formatMoney(y.totalLiabilitiesNominal)} | ${formatMoney(y.netWorthNominal)} | ${formatMoney(y.netWorthReal)} |`
      );
    }

    const lastYear = projection.years[projection.years.length - 1];
    if (lastYear) {
      lines.push("");
      lines.push(`### Ending account balances (${lastYear.year})`);
      for (const a of projection.accounts) {
        const balance = lastYear.accountBalances[a.id] ?? 0;
        lines.push(`- ${a.name}: ${formatMoney(balance)}${a.isExcluded ? " (excluded — frozen at its starting balance)" : ""}`);
      }
    }
  } catch {
    // If the scenario can't currently be projected (e.g. mid-edit invalid state), skip the summary rather than fail the export.
    lines.push(section("Projected Summary (KPIs)"));
    lines.push("The projection could not be computed for this scenario, so no results are included. The inputs above are still complete.");
  }

  lines.push(section("Levers — Every Input the User Can Change"));
  lines.push(
    "When suggesting a change, name the specific input below and, where possible, the section of the app it lives in. Anything not on this list is not user-editable and shouldn't be recommended."
  );
  lines.push("");
  lines.push("- **Household** — each person's birth date, retirement age, and planning end age (which sets the plan horizon).");
  lines.push("- **Settings** — plan start/end dates, inflation rate, filing status, whether RMDs are modeled, and the flat state/local tax add-on.");
  lines.push("- **Routing tab** — which accounts are spending hubs and their buffer amounts; the fill order, each stop's cap and cap growth rate, and the fill split mode; the drain order, each stop's date window, minimum-balance floor, and the drain split mode. Reordering the drain order is the highest-leverage tax change available.");
  lines.push("- **Accounts** — name, class, tax treatment, owner, starting balance, growth rate (or a dated growth-rate schedule), RMD flag, loan terms, and the contribution (amount, frequency, growth, payroll-deducted flag, end date) or a multi-segment contribution schedule.");
  lines.push("- **Income sources** — amount, frequency (or an every-N-years interval), nominal growth rate, owner, deposit account, start/end dates, category, and temporary adjustment windows.");
  lines.push("- **Expenses** — amount, frequency (or an every-N-years interval), nominal growth rate, payment account, start/end dates, category, and temporary adjustment windows.");
  lines.push("- **Events** — retire, buy a home, have a kid, and custom transfer, each with its own fields as shown above.");
  lines.push("- **`isExcluded`** — on any account, income source, expense, or event. Toggling this is the cleanest way to test one item's impact without deleting it.");
  lines.push("");
  lines.push(
    "Note that some values are *derived* and cannot be edited directly: an account's category (asset vs liability) follows from its class; the tax brackets and standard deduction come from IRS tables indexed by the inflation rate; RMD divisors come from the IRS life-expectancy table; a loan's monthly payment is computed by amortization unless explicitly overridden; and payroll-deducted contributions stop at the owner's retirement unless given an explicit end date."
  );

  return lines.join("\n") + "\n";
}
