import type { Id, ProjectionResult } from "@/domain";

/**
 * Human-readable money-flow trace for a single year: Extra Savings' starting
 * and ending balance (its floor is hardcoded at $0 -- no user-configurable
 * buffer to report), the operating gap it's covering, every engine-initiated
 * movement (splits, cap overflows, RMDs, deficit draws), and the ending
 * balances.
 *
 * Diagnostic only -- nothing in the app calls this. It exists because a
 * routing loop (money leaving an account and being pulled straight back)
 * looks identical to legitimate spending in the year-level totals; it only
 * becomes obvious when you can see the same dollars crossing back and forth
 * month by month. Call it from a test or a `vitest` scratch file:
 *
 *   console.log(traceYear(projectScenario(scenario), 2047));
 */
export function traceYear(result: ProjectionResult, year: number): string {
  const snapshot = result.years.find((y) => y.year === year);
  if (!snapshot) return `No projected year ${year} (plan covers ${result.years[0]?.year}-${result.years[result.years.length - 1]?.year}).`;

  const money = (n: number) => (n < 0 ? `-$${Math.round(-n).toLocaleString()}` : `$${Math.round(n).toLocaleString()}`);
  const nameOf = (id: Id) => result.accounts.find((a) => a.id === id)?.name ?? id;

  const extraSavingsId = result.accounts.find((a) => a.isExtraSavings)?.id;

  const lines: string[] = [`=== ${year} money-flow trace ===`];

  // Extra Savings' start/end balance -- its floor is hardcoded at $0, no
  // user-configurable buffer to report.
  if (extraSavingsId) {
    const roll = snapshot.rollforwards.find((r) => r.accountId === extraSavingsId);
    if (roll) {
      lines.push(
        `  Extra Savings (${nameOf(extraSavingsId)}): start ${money(roll.startingBalance)} -> end ${money(roll.endingBalance)}  (floor: $0)`
      );
    }
  } else {
    lines.push(`  WARNING: no account is flagged isExtraSavings.`);
  }

  const cf = snapshot.cashFlow;
  lines.push(
    `  income ${money(cf.totalIncome)} | expenses ${money(cf.totalExpenses)} | operating gap ${money(cf.totalExpenses - cf.totalIncome)}`
  );

  // Every engine-initiated movement this year, collapsed to one line per
  // kind + route, with the month count -- 12 round trips of the same amount is
  // the signature of a routing loop.
  const inYear = result.ledger.filter((e) => e.date.startsWith(`${year}-`));
  const routes = new Map<string, { kind: string; from: Id; to?: Id; total: number; months: number }>();
  for (const e of inYear) {
    const key = `${e.kind}|${e.accountId}|${e.toAccountId ?? ""}`;
    const r = routes.get(key) ?? { kind: e.kind, from: e.accountId, to: e.toAccountId, total: 0, months: 0 };
    r.total += e.amount;
    r.months += 1;
    routes.set(key, r);
  }
  lines.push(`  movements:`);
  if (routes.size === 0) lines.push(`    (none)`);
  for (const r of [...routes.values()].sort((a, b) => b.total - a.total)) {
    lines.push(
      `    ${r.kind.padEnd(19)} ${nameOf(r.from)}${r.to ? ` -> ${nameOf(r.to)}` : ""}: ${money(r.total)} over ${r.months} mo`
    );
  }

  lines.push(`  withdrawals booked (gross = net + tax):`);
  if (cf.withdrawalsByAccount.length === 0) lines.push(`    (none)`);
  for (const w of cf.withdrawalsByAccount) {
    lines.push(`    ${w.label}: gross ${money(w.gross)} = net ${money(w.net)} + tax ${money(w.tax)}  [${w.taxTreatment}]`);
  }
  lines.push(`  surplus routed ${money(cf.surplusRouted)} | withdrawal taxes ${money(cf.withdrawalTaxes)} | federal tax ${money(cf.federalTaxTotal)}`);

  lines.push(`  ending balances:`);
  for (const account of result.accounts) {
    const balance = snapshot.accountBalances[account.id] ?? 0;
    if (Math.abs(balance) < 0.005) continue;
    lines.push(`    ${account.name}${account.id === extraSavingsId ? " (Extra Savings)" : ""}: ${money(balance)}`);
  }
  lines.push(`  net worth ${money(snapshot.netWorthNominal)} (real ${money(snapshot.netWorthReal)})`);

  return lines.join("\n");
}
