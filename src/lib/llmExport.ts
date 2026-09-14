import type {
  Account,
  DateAnchor,
  DrainStop,
  ExpenseBaseline,
  IncomeSource,
  Person,
  SplitStop,
  Scenario,
  ScenarioEvent,
  TemporaryAdjustment,
} from "@/domain";
import { anchorLabel, retirementDateOf } from "@/domain";
import { projectScenario } from "@/engine/forecastScenario";
import { STRATEGY_DESCRIPTIONS, STRATEGY_LABELS, deriveDrainOrder } from "@/engine/strategy";
import { todayISO } from "@/engine/dateMath";
import { formatMoney } from "@/lib/format";

const PREAMBLE = `This is a Markdown export of one scenario from a personal retirement/financial forecasting app, for discussion with an AI assistant. It is not financial advice, and no assumptions here are guaranteed to be accurate.

**How to use this document.** It contains everything needed to reason about the plan: a glossary of the app's terms, a description of how the forecast engine actually computes the numbers, the complete set of user-editable inputs, and the resulting projection. When answering questions or suggesting changes, work from the engine's real mechanics described below rather than from generic financial-planning heuristics — this model has specific rules (deterministic, no Monte Carlo; nominal growth rates; a routing waterfall; exact bracket-based tax) that determine which inputs actually move the outcome. The "Levers" section at the end lists every input the user can change.`;

const GLOSSARY = `## Glossary

- **Take-home / net income**: every income source's \`amount\` in this export (except Social Security and pension, see below) is already **net of taxes and payroll deductions** — the actual cash that lands in an account.
- **Social Security & pension are gross**: these two income categories are entered as their **gross** (pre-tax) amount. The engine computes tax on them itself (Social Security is only partly taxable, per IRS rules); don't treat their listed amount as take-home cash.
- **Account \`class\`**: the type of account — \`cash\`, \`taxable_investment\`, \`tax_deferred\` (traditional 401k/IRA), \`tax_free\` (Roth), \`hsa\` (health savings: paycheck-funded, withdrawals tax-free), \`education_529\` (withdrawals tax-free), \`real_estate\`, \`other_asset\`, \`credit_card\`, \`loan\`, or \`mortgage\`. Anything in \`credit_card\`/\`loan\`/\`mortgage\` is a liability; everything else is an asset.
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
4. **RMDs.** Every January (when RMDs are enabled in settings), for accounts flagged \`subjectToRMD\`, the prior Dec-31 balance divided by the IRS life-expectancy divisor for the owner's age is forced out, taxed, and deposited to Extra Savings. Per SECURE 2.0, RMDs start at age 73 for owners born 1951-1959 and at 75 for anyone born 1960 or later. Roth accounts are never subject to RMDs.
5. **Surplus split (Extra Savings).** Extra Savings' "fresh surplus" for the month is exactly what steps 1–4 added to its balance THIS month — not its whole running balance, so money left unclaimed in a prior month (a deliberate reserve) is never re-offered to the split. Each split-order stop, in list order, is offered either a flat dollar amount or a percentage of what's left after the stops above it (cascading — not a share of the original total), clamped by its own optional balance cap; whatever the whole list doesn't claim stays in Extra Savings.
6. **Cap overflow rebalance.** Any split stop sitting above its cap (from growth, or money that landed in it directly) pushes the excess down to later stops with room. This is a transfer between the user's own accounts, so it doesn't count as routed surplus, but selling out of a taxable account still realizes tax.
7. **Deficit cascade (the drain order).** If Extra Savings' balance would drop below $0, the shortfall is pulled from the drain order, mirroring the surplus split's cascading model: each stop, in list order, is offered either a flat dollar amount or a percentage of what's left after the stops above it, clamped by its own optional floor — whatever it can't cover spills to the next stop. Only stops whose date window covers the month participate. Each draw is sized so the withdrawal *plus its own tax* fits in what's available.

**Taxes.** Any dollar leaving a \`tax_deferred\` account is taxed as ordinary income in full, plus a 10% early-withdrawal penalty if the owner is under 59½ (unless the account is flagged exempt via 72(t)/rule of 55). Any dollar leaving a \`taxable\` account is taxed only on its realized-gain portion, using **average-cost basis**: basis is the account's \`startingCostBasis\` (or the whole starting balance when unset) plus every dollar of new money added since (contributions, routed surplus, transfers); growth never adds basis. \`tax_free\` (Roth) and cash withdrawals realize no tax. The estimated tax withheld on a withdrawal is deducted from the same account it came out of.

**Money sent to a liability pays it down.** A transfer (or income) directed at a mortgage/loan/credit-card account reduces the amount owed, capped at the remaining balance; any excess returns to Extra Savings. Money taken FROM a liability is borrowing and grows the amount owed.

**Roth conversions and rollovers are their own events.** A \`roth_conversion\` moves money from a tax-deferred account to a Roth: the amount is ordinary income in that year, never subject to the 10% penalty, and its tax is paid from Extra Savings (or withheld from the conversion when \`taxSource\` is \`withhold\`). A "fill to the top of a bracket" conversion runs each December and converts just enough to bring that year's ordinary taxable income up to the top of the named bracket. A \`rollover\` between two tax-deferred accounts is not a taxable event. A \`pay_off_loan\` event pays a loan down or off from an asset account on a date, and an \`open_loan\` event is its mirror image: it takes a new non-mortgage loan on, creating the debt and starting its payments (borrowing is not income -- only the cash, if any, that lands in an account).

**Death is modelled.** Each person's \`planningEndAge\` is the age they are modelled as passing. From that date their salary, rental, and other income stop; a pension continues at its \`survivorPct\` share (else stops); of two Social Security benefits the survivor keeps the larger; their accounts pass to the survivor for age-based rules; and a married household files single from the following calendar year.

At year-end the engine computes the **exact** federal bill from real IRS bracket tables (brackets and the standard deduction are inflation-indexed forward from 2026): ordinary income = gross tax-deferred withdrawals + gross pension + the taxable portion of Social Security (per the IRS partial-inclusion rule), less the standard deduction; long-term capital gains are stacked on top of ordinary income in the LTCG brackets; early-withdrawal penalties are added on top. The optional flat add-on rate is applied to the same combined base to approximate state/local tax. **Each December the estimated withholding is settled against this exact bill** -- a refund (or extra charge) posted to Extra Savings -- so the household's actual cash tax for a year always equals the exact bracket bill, and the balances/net-worth trajectory reflect it. Because tax during the monthly loop depends on rates that depend on the year's income, the whole simulation is re-run a few times until each year's marginal-rate estimate converges on its actual result.

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

function fmtGrowth(rate: number | null | undefined): string {
  if (rate == null) return "growth matches the plan's inflation rate (left blank)";
  if (!rate) return "flat in nominal terms (0% growth)";
  return `growing ${fmtPct(rate)}/yr (nominal)`;
}

/**
 * A note saying that a date is DERIVED from a retirement, not typed in.
 * Without this, an advisor reading the export sees a hard date and has no way
 * to know it moves on its own when the retirement age is changed.
 */
function fmtAnchors(
  item: { startAnchor?: DateAnchor | null; endAnchor?: DateAnchor | null },
  people: readonly Person[]
): string[] {
  const parts: string[] = [];
  if (item.startAnchor) parts.push(`its start date follows ${anchorLabel(item.startAnchor, people)}`);
  if (item.endAnchor) parts.push(`its end date is the day before ${anchorLabel(item.endAnchor, people)}`);
  if (!parts.length) return [];
  return [`  - Linked date: ${parts.join("; ")} — recomputed whenever that retirement moves.`];
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
      `- **${p.name}** (id: \`${p.id}\`) — born ${p.birthDate}, ${
        retirementDateOf(p)
          ? `retires ${retirementDateOf(p)} (age ${p.retirementAge}${p.retirementDate ? ", from an exact date rather than the age" : ""}) — their salary and paycheck contributions stop then, and any date linked to their retirement moves with it`
          : "**modelled as never retiring** (their salary runs to the end of the plan)"
      }, modelled as living to age ${p.planningEndAge} (the plan runs through the latest such date; see "Death is modelled" above).`
    );
  }

  lines.push(section("Settings"));
  const s = scenario.settings;
  lines.push(
    `- Plan start date: ${s.startDate ?? `${todayISO()} (auto: today's date, since no override is set)`}`
  );
  lines.push(`- Plan horizon end date: ${s.horizonEndDate}`);
  lines.push(`- Inflation rate (annual): ${fmtPct(s.inflationRatePct)}`);
  lines.push(`- Filing status: ${s.filingStatus}`);
  lines.push(`- RMDs enabled: ${s.rmdEnabled ? "yes" : "no"}`);
  lines.push(
    `- Additional flat state/local tax add-on: ${fmtPct(s.additionalFlatTaxRatePct)}${
      s.additionalFlatTaxRatePct === 0 ? " (none — e.g. correct as-is in a no-income-tax state)" : ""
    }`
  );
  lines.push(
    `- Expected return: ${
      s.planReturnRatePct == null
        ? "each account uses its own growth rate"
        : `**${fmtPct(s.planReturnRatePct)}/yr nominal for every investment account** (taxable, tax-deferred, Roth, HSA, 529) — each account's own rate and scheduled changes are ignored while this is on; cash and real estate keep their own rates`
    }`
  );
  lines.push(
    `- Cash buffer: ${
      s.cashBufferTarget == null
        ? "none (each month draws exactly what it needs)"
        : `keep ${formatMoney(s.cashBufferTarget)} (today's dollars) in Extra Savings — the drain order tops it back up whenever spending draws it down`
    }`
  );
  const hc = s.healthcare;
  if (!hc.enabled) {
    lines.push("- Healthcare model: off (any healthcare costs are ordinary expenses entered by hand)");
  } else {
    const retired =
      hc.retiredCoverage === "marketplace"
        ? "a marketplace (ACA) plan"
        : hc.retiredCoverage === "cobra_then_marketplace"
          ? `COBRA for ${hc.cobra.months} months at ${formatMoney(hc.cobra.monthlyPremiumPerPerson)}/person/month, then a marketplace plan`
          : hc.retiredCoverage === "fixed"
            ? `a retiree plan or other fixed premium of ${formatMoney(hc.fixedMonthlyPremiumPerPerson)}/person/month`
            : "no premium";
    lines.push(
      `- Healthcare model: **on**. Costs grow ${hc.costGrowthRatePct == null ? "with inflation" : `${fmtPct(hc.costGrowthRatePct)}/yr`}. While someone has a salary: ${formatMoney(hc.workingMonthlyPremiumPerPerson)}/person/month out of take-home${hc.spouseCoverageWhileWorking ? " (a working spouse's plan covers everyone under 65)" : ""}. Before 65 once nobody works: ${retired}${
        hc.retiredCoverage === "marketplace" || hc.retiredCoverage === "cobra_then_marketplace"
          ? ` — benchmark plan ${formatMoney(hc.marketplace.benchmarkMonthlyPremiumPerPerson)}/person/month today${hc.marketplace.ageRated ? ", rising with age along the federal age curve" : ""}${hc.marketplace.premiumTaxCredit ? `, with the premium tax credit applied against the plan's own income each year (${hc.marketplace.enhancedSubsidies ? "enhanced 2021-2025 schedule, no income cap" : "current law: no credit under the poverty line or above four times it"})` : ", full price (no credit)"}`
          : ""
      }. From 65: Medicare — Part B standard premium built in (2026: $202.90/month), Part D ${formatMoney(hc.medicare.partDMonthlyPremium)}/month, supplement ${formatMoney(hc.medicare.supplementMonthlyPremium)}/month${hc.medicare.irmaa ? ", plus IRMAA surcharges when income two years earlier is above the thresholds" : ", no IRMAA"}. Out of pocket: ${formatMoney(hc.outOfPocket.preMedicareAnnualPerPerson)}/person/yr before 65, ${formatMoney(hc.outOfPocket.medicareAnnualPerPerson)}/person/yr on Medicare${hc.outOfPocket.payFromHsa ? ", paid from an HSA while it lasts" : ""}. These post as expenses named "Medicare: …", "Marketplace health insurance", "COBRA: …", "Out-of-pocket medical: …".`
    );
  }

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
      const target = scenario.accounts.find((a) => a.id === stop.accountId);
      if (target?.balanceCeiling == null) {
        parts.push("uncapped (catch-all — absorbs everything offered to it)");
      } else {
        const capGrowth =
          target.balanceCeilingGrowthRatePct == null
            ? `growing with inflation (${fmtPct(s.inflationRatePct)}/yr)`
            : `growing ${fmtPct(target.balanceCeilingGrowthRatePct)}/yr`;
        parts.push(`capped at ${formatMoney(target.balanceCeiling)} (set on the account), ${capGrowth}`);
      }
      if (stop.limitAmount != null) {
        parts.push(`at most ${formatMoney(stop.limitAmount)} per ${stop.limitPeriod ?? "annual"} period`);
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
  lines.push(`### Drain order (what's sold to cover a shortfall)`);
  lines.push(
    `Withdrawal strategy: **${STRATEGY_LABELS[s.withdrawalStrategy]}** — ${STRATEGY_DESCRIPTIONS[s.withdrawalStrategy]}${
      s.withdrawalStrategy === "custom" ? "" : " The order below is derived from the accounts by that preset (an account added later joins it automatically); homes, other assets, HSAs and 529s are never drawn."
    }`
  );
  lines.push(
    "Each stop, in list order, is offered either a flat dollar amount or a percentage of what's left after the stops above it (cascading — not a share of the original shortfall), then clamped by its own optional floor; whatever it can't cover spills to the next stop."
  );
  lines.push(
    "This order determines which accounts' gains and ordinary income are realized in which years, so it is the primary lever on the lifetime tax bill."
  );
  const drainOrder = s.withdrawalStrategy === "custom" ? mf.drainOrder : deriveDrainOrder(s.withdrawalStrategy, scenario.accounts);
  if (drainOrder.length === 0) {
    lines.push("- None configured — an Extra Savings shortfall cannot be covered and the account will simply run negative (raising an insufficient-funds warning).");
  } else {
    drainOrder.forEach((stop: DrainStop, i) => {
      const parts: string[] = [];
      const account = scenario.accounts.find((a) => a.id === stop.accountId);
      if (account) parts.push(`${account.class} / ${account.taxTreatment}`);
      parts.push(
        stop.kind === "flat"
          ? `flat ${stop.amount == null ? "unset (covers nothing)" : formatMoney(stop.amount)} (today's dollars, grown by inflation)`
          : `${stop.pct == null ? "unset (covers nothing)" : fmtPct(stop.pct)} of what's left after the stops above it`
      );
      if (account?.balanceFloor != null) {
        const floorGrowth =
          account.balanceFloorGrowthRatePct == null
            ? `inflation (${fmtPct(s.inflationRatePct)}/yr)`
            : `${fmtPct(account.balanceFloorGrowthRatePct)}/yr`;
        parts.push(`never drained below ${formatMoney(account.balanceFloor)} (set on the account; today's dollars, grown by ${floorGrowth})`);
      } else {
        parts.push("no floor");
      }
      if (stop.limitAmount != null) {
        parts.push(`at most ${formatMoney(stop.limitAmount)} per ${stop.limitPeriod ?? "annual"} period`);
      }
      if (stop.startDate || stop.endDate) {
        parts.push(`active ${stop.startDate ?? "plan start"} → ${stop.endDate ?? "plan end"}`);
      } else {
        parts.push("active for the whole plan");
      }
      lines.push(`${i + 1}. **${accountName(stop.accountId)}** — ${parts.join("; ")}.`);
    });
  }

  lines.push(section("Accounts"));
  for (const a of scenario.accounts as Account[]) {
    lines.push(
      `- **${a.name}** (id: \`${a.id}\`) — class: ${a.class} (${a.category}), tax treatment: ${a.taxTreatment}, owner: ${personName(a.ownerId)}, starting balance: ${formatMoney(a.startingBalance)}, growth rate: ${a.growthRatePct == null ? "matches the plan's inflation rate" : `${fmtPct(a.growthRatePct)}/yr nominal`}${a.subjectToRMD ? ", subject to RMDs" : ""}${a.noEarlyWithdrawalPenalty ? ", exempt from the 10% early-withdrawal penalty (72(t)/rule of 55)" : ""}${a.isExtraSavings ? " — **this is the mandatory Extra Savings account** (see Money Flow / Routing above)" : ""}${a.isExcluded ? " — **excluded from the plan** (engine skips it entirely)" : ""}`
    );
    if (a.startDate) {
      lines.push(`  - Doesn't exist until ${a.startDate} — starting balance above is its value as of that date, not plan start.`);
    }
    if (a.startingCostBasis != null) {
      lines.push(`  - Starting cost basis: ${formatMoney(a.startingCostBasis)} (vs. starting balance of ${formatMoney(a.startingBalance)} — the difference is embedded unrealized gains).`);
    }
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
    if (a.balanceCeiling != null) lines.push(`  - Balance cap: ${formatMoney(a.balanceCeiling)} (today's dollars).`);
    if (a.balanceFloor != null) lines.push(`  - Balance floor: ${formatMoney(a.balanceFloor)} (today's dollars).`);
    if (a.class === "real_estate") {
      const ownership = [
        a.propertyTaxRatePct ? `property tax ${fmtPct(a.propertyTaxRatePct)}/yr of value` : null,
        a.homeInsuranceRatePct ? `insurance ${fmtPct(a.homeInsuranceRatePct)}/yr of value` : null,
        a.maintenanceRatePct ? `maintenance ${fmtPct(a.maintenanceRatePct)}/yr of value` : null,
      ].filter(Boolean);
      if (ownership.length) lines.push(`  - Ongoing costs: ${ownership.join(", ")}.`);
    }
  }

  for (const p of scenario.household.people) {
    if (!p.retirementSpending?.amount) continue;
    const rs = p.retirementSpending;
    lines.push(
      `  - ${p.name}'s retirement spending: ${formatMoney(rs.amount)}/yr from ${accountName(rs.paymentAccountId)}, ${fmtGrowth(rs.growthRatePct)}, starting the day they retire${rs.endDate ? ` and running through ${rs.endDate}` : ""}.`
    );
    lines.push(...fmtAdjustments(rs.adjustments));
    if (p.retirementNotes) lines.push(`  - Note on ${p.name}'s retirement: ${p.retirementNotes}`);
  }

  lines.push(section("Income Sources"));
  if (scenario.incomeSources.length === 0) {
    lines.push("- None.");
  }
  for (const inc of scenario.incomeSources as IncomeSource[]) {
    const gross = inc.category === "social_security" || inc.category === "pension";
    lines.push(
      `- **${inc.name}** (id: \`${inc.id}\`, category: ${inc.category}) — ${fmtRecurrence(inc.amount, inc.frequency, inc.intervalYears)} ${gross ? "**gross (pre-tax)**" : "take-home (net of tax)"}, ${fmtGrowth(inc.growthRatePct)}, owner: ${personName(inc.ownerId)}, deposits to ${accountName(inc.depositAccountId)}, ${inc.startDate} → ${inc.endDate ?? "end of plan"}${inc.claimAge != null ? `, claimed at age ${inc.claimAge}` : ""}${inc.category === "pension" ? `, survivor benefit ${fmtPct(inc.survivorPct ?? 0)}` : ""}${inc.isExcluded ? " — **excluded**" : ""}`
    );
    if (inc.grossAmount != null) {
      lines.push(
        `  - Gross (Box-1-style) amount: ${formatMoney(inc.grossAmount)} — used to stack withdrawals/gains on top of this person's true tax bracket while still working, instead of assuming $0 other ordinary income.`
      );
    }
    lines.push(...fmtAnchors(inc, scenario.household.people));
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
    lines.push(...fmtAnchors(exp, scenario.household.people));
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
      lines.push(...fmtAnchors(ev, scenario.household.people));
      switch (ev.type) {
        case "buy_home": {
          // Rates/mortgage terms now live on the linked real_estate account
          // (and its own linked mortgage account) -- see BuyHomeEvent.realEstateAccountId.
          const home = scenario.accounts.find((a) => a.id === ev.realEstateAccountId);
          const mortgage = home?.linkedLiabilityId
            ? scenario.accounts.find((a) => a.id === home.linkedLiabilityId)
            : undefined;
          const financing = mortgage?.loanTerms
            ? `Down payment ${formatMoney(ev.downPaymentAmount)} from ${accountName(ev.downPaymentFromAccountId)}. Mortgage: ${fmtPct(mortgage.loanTerms.annualInterestRatePct)} over ${mortgage.loanTerms.termMonths} months${mortgage.loanTerms.extraPrincipalMonthly ? `, plus ${formatMoney(mortgage.loanTerms.extraPrincipalMonthly)}/mo extra principal` : ""}.`
            : `Paid in cash from ${accountName(ev.downPaymentFromAccountId)} — no mortgage created.`;
          const ownership = [
            home?.propertyTaxRatePct ? `property tax ${fmtPct(home.propertyTaxRatePct)}/yr of value` : null,
            home?.homeInsuranceRatePct ? `insurance ${fmtPct(home.homeInsuranceRatePct)}/yr of value` : null,
            home?.maintenanceRatePct ? `maintenance ${fmtPct(home.maintenanceRatePct)}/yr of value` : null,
          ].filter(Boolean);
          lines.push(
            `  - Purchase price ${formatMoney(ev.purchasePrice)}, property grows ${fmtPct(home?.propertyGrowthRatePct ?? 0)}/yr. ${financing}${ownership.length ? ` Ongoing: ${ownership.join(", ")}.` : ""}${ev.replaceHousingExpenses ? " Replaces any existing 'Housing' category expense as of this purchase date." : ""}`
          );
          break;
        }
        case "sell_home":
          lines.push(
            ev.sellingCostsPct != null
              ? `  - Sells ${accountName(ev.realEstateAccountId)} into ${accountName(ev.proceedsAccountId)}: proceeds are **computed from the projection**, not fixed -- the home's simulated value at the sale month × (1 − ${fmtPct(ev.sellingCostsPct)} selling costs) − whatever's left on the linked mortgage. The netProceeds field (${formatMoney(ev.netProceeds)}) is ignored while sellingCostsPct is set.`
              : `  - Sells ${accountName(ev.realEstateAccountId)}, netting ${formatMoney(ev.netProceeds)} into ${accountName(ev.proceedsAccountId)} after any agent commission, closing costs, and mortgage payoff.`
          );
          lines.push(
            `  - That home's asset and mortgage are both fully retired (zeroed) this date -- not just stopped, unlike a buy_home event's "replace existing housing expenses".`
          );
          break;
        case "roth_conversion":
          lines.push(
            ev.fillToBracketRate != null
              ? `  - Each December${ev.frequency === "one_time" ? " of the start year only" : ""}, convert from ${accountName(ev.fromAccountId)} to ${accountName(ev.toAccountId)} just enough to fill ordinary taxable income to the top of the ${fmtPct(ev.fillToBracketRate)} bracket. Tax ${ev.taxSource === "withhold" ? "withheld from the conversion" : "paid from Extra Savings"}.`
              : `  - Convert ${formatMoney(ev.amount ?? 0)} ${ev.frequency === "one_time" ? "once" : "per year"} from ${accountName(ev.fromAccountId)} to ${accountName(ev.toAccountId)}, ${fmtGrowth(ev.growthRatePct)}. Ordinary income, no penalty; tax ${ev.taxSource === "withhold" ? "withheld from the conversion" : "paid from Extra Savings"}.`
          );
          break;
        case "open_loan":
          lines.push(
            `  - ${ev.loanKind === "heloc" ? "Draw" : "Take out"} ${formatMoney(ev.principal)} ${ev.loanKind === "heloc" ? "on" : "as"} ${accountName(ev.loanAccountId)}${ev.loanKind === "heloc" ? " (a home equity line: interest-only through its draw period, then amortized over the repayment period; paid off if the home sells)" : ""} (today's dollars, inflated to the start date). ${
              ev.proceedsAccountId == null
                ? "The money paid for something outside the plan, so no account receives it -- only the debt and its monthly payments appear."
                : `The money is deposited into ${accountName(ev.proceedsAccountId)}.`
            } Payments amortize from the spending hub.`
          );
          break;
        case "pay_off_loan":
          lines.push(
            `  - Pay ${ev.amount == null ? "off whatever is left on" : `${formatMoney(ev.amount)} toward`} ${accountName(ev.loanAccountId)} from ${accountName(ev.fromAccountId)}.`
          );
          break;
        case "rollover":
          lines.push(
            `  - Roll ${ev.amount == null ? "the whole balance" : formatMoney(ev.amount)} from ${accountName(ev.fromAccountId)} into ${accountName(ev.toAccountId)} (not a taxable event).`
          );
          break;
        case "custom_transfer":
          lines.push(
            `  - ${fmtRecurrence(ev.amount, ev.frequency, ev.intervalYears)} from ${accountName(ev.fromAccountId)} to ${accountName(ev.toAccountId)}, ${fmtGrowth(ev.growthRatePct)}.`
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
      "All figures are nominal (future dollars) except the last column. Income is take-home plus gross Social Security/pension; Surplus routed is cash swept from the hub(s) into the fill order; Withdrawals is net cash pulled from accounts to cover the gap (including RMD proceeds); Ending cash is the combined balance of EVERY cash-class account (the spending hub plus any other cash accounts such as checking or a cash reserve), not the hub alone -- so a rise in this column can reflect a non-hub cash account growing rather than cash piling up in the hub."
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
  lines.push("- **Household** — each person's birth date, retirement age, and planning end age (the age they are modelled as living to; it sets the plan horizon and drives the survivor rules).");
  lines.push("- **Settings** — plan start/end dates, inflation rate, filing status, whether RMDs are modeled, and the flat state/local tax add-on.");
  lines.push("- **Routing tab** — the withdrawal strategy (a preset, or a custom drain order with each stop's kind, per-period max draw, and date window), the cash buffer, and the split order (each stop's flat-amount-or-percentage kind, per-period limit, and date window). An account's balance cap and floor live on the account. Changing the withdrawal strategy is the highest-leverage tax change available.");
  lines.push("- **Assumptions › Expected return** — one return for every investment account (switchable; per-account rates apply when it is off). **Assumptions › Healthcare** — the healthcare model's coverage choices, premiums, and out-of-pocket figures.");
  lines.push("- **Stress test tab** — the plan re-run with lower returns, a bear market at retirement, higher inflation, a Social Security cut, a longer life, or all at once; not saved with the plan.");
  lines.push("- **Accounts** — name, class, tax treatment, owner, starting balance, starting cost basis, growth rate (or a dated growth-rate schedule), RMD flag, early-withdrawal-penalty exemption, an account start date (for a not-yet-existing account), loan terms, and the contribution (amount, frequency, growth, payroll-deducted flag, end date) or a multi-segment contribution schedule.");
  lines.push("- **Income sources** — amount, an optional gross (Box-1-style) amount for bracket placement while working, frequency (or an every-N-years interval), nominal growth rate (a pension's blank = 0, no COLA), owner, deposit account, start/end dates, category, a claiming age for Social Security/pension, a pension's survivor share, and temporary adjustment windows.");
  lines.push("- **Expenses** — amount, frequency (or an every-N-years interval), nominal growth rate, payment account, start/end dates, category, and temporary adjustment windows.");
  lines.push("- **Events** — retire, buy a home, sell a home, Roth conversion (fixed amount or fill-to-bracket), pay off a loan, rollover, and custom transfer, each with its own fields as shown above.");
  lines.push("- **`isExcluded`** — on any account, income source, expense, or event. Toggling this is the cleanest way to test one item's impact without deleting it.");
  lines.push("");
  lines.push(
    "Note that some values are *derived* and cannot be edited directly: an account's category (asset vs liability) follows from its class; the tax brackets and standard deduction come from IRS tables indexed by the inflation rate; RMD divisors come from the IRS life-expectancy table; a loan's monthly payment is computed by amortization unless explicitly overridden; and payroll-deducted contributions stop at the owner's retirement unless given an explicit end date."
  );

  return lines.join("\n") + "\n";
}
