import type { Person, ProjectionResult } from "@/domain";
import { ageOn } from "@/engine/dateMath";
import { sortAccountsForDisplay } from "@/lib/labels";

/**
 * The projection as a spreadsheet: one row per year, the headline figures,
 * then every account's year-end balance. Nominal (future) dollars, since a
 * spreadsheet can deflate but cannot un-deflate; the inflation deflator is
 * its own column so today's-dollar figures are one formula away.
 */

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "number" ? String(Math.round(value * 100) / 100) : value;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function projectionToCsv(result: ProjectionResult, people: Person[]): string {
  const accounts = sortAccountsForDisplay(result.accounts.filter((a) => !a.isExcluded));
  const header = [
    "Year",
    ...people.map((p) => `${p.name} age`),
    "Net worth",
    "Net worth (today's dollars)",
    "Inflation deflator",
    "Total assets",
    "Total liabilities",
    "Income",
    "Expenses",
    "Operating surplus",
    "Federal tax",
    "Withdrawals to cash (net)",
    "RMDs",
    "Roth conversions",
    "Surplus swept into accounts",
    "Cash on hand (year end)",
    ...accounts.map((a) => a.name),
  ];
  const lines = [header.map(cell).join(",")];
  for (const y of result.years) {
    const cf = y.cashFlow;
    lines.push(
      [
        y.year,
        ...people.map((p) => ageOn(p.birthDate, y.date)),
        y.netWorthNominal,
        y.netWorthReal,
        y.inflationDeflator,
        y.totalAssetsNominal,
        y.totalLiabilitiesNominal,
        cf.totalIncome,
        cf.totalExpenses,
        cf.operatingCashFlow,
        cf.federalTaxTotal,
        cf.withdrawalsToCashNet,
        cf.rmdTotal,
        cf.rothConversions,
        cf.surplusRouted,
        cf.endingCashBalance,
        ...accounts.map((a) => (a.category === "liability" ? -1 : 1) * (y.accountBalances[a.id] ?? 0)),
      ]
        .map(cell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}
