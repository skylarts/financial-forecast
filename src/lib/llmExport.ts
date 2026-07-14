import type { Scenario } from "@/domain";
import { projectScenario } from "@/engine/forecastScenario";
import { formatMoney } from "@/lib/format";

const GLOSSARY = `## Glossary

- **Take-home / net income**: every income source's \`amount\` in this export (except Social Security and pension, see below) is already **net of taxes and payroll deductions** — the actual cash that lands in an account.
- **Social Security & pension are gross**: these two income categories are entered as their **gross** (pre-tax) amount. The engine computes tax on them itself (Social Security is only partly taxable, per IRS rules); don't treat their listed amount as take-home cash.
- **Account \`class\`**: the type of account — \`cash\`, \`taxable_investment\`, \`tax_deferred\` (traditional 401k/IRA), \`tax_free\` (Roth), \`real_estate\`, \`other_asset\`, \`credit_card\`, \`loan\`, or \`mortgage\`. Anything in \`credit_card\`/\`loan\`/\`mortgage\` is a liability; everything else is an asset.
- **Account \`taxTreatment\`**: how withdrawals/growth are taxed — \`taxable\` (brokerage/savings), \`tax_deferred\` (pay ordinary income tax on withdrawal, e.g. traditional 401k/IRA), \`tax_free\` (Roth — no tax on qualified withdrawals), or \`n/a\` (real estate, loans, etc.).
- **Routing (hubs / fill order / drain order)**: money doesn't move between accounts arbitrarily. One or more accounts are designated **spending hubs** (income deposits here, expenses pay from here). Surplus cash above each hub's buffer sweeps into the **fill order** (an ordered list of accounts that receive extra cash, e.g. contributions or investing surplus, each with an optional balance cap). When a hub runs short, the shortfall is covered by the **drain order** (an ordered list of accounts drawn down to cover the gap, e.g. selling investments to cover a deficit).
- **Nominal vs. real dollars**: "nominal" = actual future dollar amounts (what your account statement will literally say). "real" = nominal amounts deflated back to today's purchasing power using the plan's inflation rate, so you can compare a dollar in 2050 to a dollar today.
- **Federal tax**: this export's federal tax figures are the plan's **exact annual bracket bill** for that year — computed from the real IRS bracket tables for the filing status below, not a flat estimate.
`;

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function section(title: string): string {
  return `\n## ${title}\n`;
}

export function buildLlmExport(scenario: Scenario): string {
  const lines: string[] = [];

  lines.push(`# Financial Forecast Export — "${scenario.name}"`);
  lines.push("");
  lines.push(
    "This is a Markdown export of one scenario from a personal retirement/financial forecasting app, for discussion with an AI assistant. It is not financial advice, and no assumptions here are guaranteed to be accurate."
  );
  lines.push(GLOSSARY);

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
  if (s.additionalFlatTaxRatePct > 0) {
    lines.push(`- Additional flat state/local tax add-on: ${fmtPct(s.additionalFlatTaxRatePct)}`);
  }
  lines.push(
    `- Money flow: ${s.moneyFlow.hubs.length} spending hub(s), ${s.moneyFlow.fillOrder.length} fill-order stop(s), ${s.moneyFlow.drainOrder.length} drain-order stop(s).`
  );

  lines.push(section("Accounts"));
  const personName = (id: string | null) => (id ? scenario.household.people.find((p) => p.id === id)?.name ?? id : "Joint");
  for (const a of scenario.accounts) {
    lines.push(
      `- **${a.name}** (id: \`${a.id}\`) — class: ${a.class}, tax treatment: ${a.taxTreatment}, owner: ${personName(a.ownerId)}, starting balance: ${formatMoney(a.startingBalance)}, growth rate: ${fmtPct(a.growthRatePct)}${a.subjectToRMD ? ", subject to RMDs" : ""}${a.isExcluded ? " (excluded from the plan)" : ""}`
    );
    if (a.contribution) {
      lines.push(
        `  - Contribution: ${formatMoney(a.contribution.amount)} per ${a.contribution.frequency}${a.contribution.payrollDeducted ? " (payroll-deducted, no separate cash outflow)" : " (drawn from spending account)"}`
      );
    }
    if (a.loanTerms) {
      lines.push(
        `  - Loan: original principal ${formatMoney(a.loanTerms.originalPrincipal)}, rate ${fmtPct(a.loanTerms.annualInterestRatePct)}, term ${a.loanTerms.termMonths} months`
      );
    }
  }

  lines.push(section("Income Sources"));
  for (const inc of scenario.incomeSources) {
    lines.push(
      `- **${inc.name}** (${inc.category}) — ${formatMoney(inc.amount)} per ${inc.frequency}, owner: ${personName(inc.ownerId)}, starts ${inc.startDate}${inc.endDate ? `, ends ${inc.endDate}` : ""}${inc.isExcluded ? " (excluded)" : ""}`
    );
  }

  lines.push(section("Expenses"));
  for (const exp of scenario.expenses) {
    lines.push(
      `- **${exp.name}** (${exp.category}) — ${formatMoney(exp.amount)} per ${exp.frequency}, starts ${exp.startDate}${exp.endDate ? `, ends ${exp.endDate}` : ""}${exp.isExcluded ? " (excluded)" : ""}`
    );
  }

  lines.push(section("Events"));
  if (scenario.events.length === 0) {
    lines.push("- None.");
  } else {
    for (const ev of scenario.events) {
      lines.push(`- **${ev.name}** (${ev.type}) — ${ev.startDate}${ev.isExcluded ? " (excluded)" : ""}`);
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
      lines.push(`- Warnings raised during projection: ${projection.warnings.length}`);
    }
  } catch {
    // If the scenario can't currently be projected (e.g. mid-edit invalid state), skip the summary rather than fail the export.
  }

  return lines.join("\n") + "\n";
}
