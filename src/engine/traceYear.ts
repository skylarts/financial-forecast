import type { Id, ProjectionResult, Scenario } from "@/domain";

/**
 * Human-readable money-flow trace for a single year: starting hub cash, the
 * buffer the engine is defending, the operating gap it's covering, every
 * engine-initiated movement (sweeps, cap overflows, RMDs, deficit draws), and
 * the ending balances.
 *
 * Diagnostic only -- nothing in the app calls this. It exists because a
 * routing loop (money leaving an account and being pulled straight back)
 * looks identical to legitimate spending in the year-level totals; it only
 * becomes obvious when you can see the same dollars crossing back and forth
 * month by month. Call it from a test or a `vitest` scratch file:
 *
 *   console.log(traceYear(projectScenario(scenario), scenario, 2047));
 */
export function traceYear(result: ProjectionResult, scenario: Scenario, year: number): string {
  const snapshot = result.years.find((y) => y.year === year);
  if (!snapshot) return `No projected year ${year} (plan covers ${result.years[0]?.year}-${result.years[result.years.length - 1]?.year}).`;

  const money = (n: number) => (n < 0 ? `-$${Math.round(-n).toLocaleString()}` : `$${Math.round(n).toLocaleString()}`);
  const nameOf = (id: Id) => result.accounts.find((a) => a.id === id)?.name ?? id;

  const { moneyFlow, startDate, inflationRatePct } = scenario.settings;
  const inflationFactor = Math.pow(1 + inflationRatePct, Math.max(0, year - Number(startDate.slice(0, 4))));
  const hubIds = moneyFlow.hubs.map((h) => h.accountId).filter((id) => result.accounts.some((a) => a.id === id));

  const lines: string[] = [`=== ${year} money-flow trace ===`];

  // Hub cash: where the year started, and the floor the deficit cascade defends.
  let requiredBuffer = 0;
  for (const hub of moneyFlow.hubs) {
    const roll = snapshot.rollforwards.find((r) => r.accountId === hub.accountId);
    if (!roll) continue;
    const buffer = (hub.bufferAmount ?? 0) * inflationFactor;
    requiredBuffer += buffer;
    lines.push(
      `  hub ${nameOf(hub.accountId)}: start ${money(roll.startingBalance)} -> end ${money(roll.endingBalance)}` +
        `  (buffer to defend: ${money(buffer)})`
    );
    // A cap on a hub is the conflict that causes routing loops -- call it out.
    const stop = moneyFlow.fillOrder.find((s) => s.accountId === hub.accountId);
    if (stop?.maxBalance != null) {
      const cap = stop.maxBalance * Math.pow(1 + (stop.maxBalanceGrowthRatePct ?? inflationRatePct), Math.max(0, year - Number(startDate.slice(0, 4))));
      lines.push(
        `    NOTE: also a fill stop capped at ${money(cap)}` +
          (cap < requiredBuffer ? ` -- BELOW its buffer; the cap is ignored` : "")
      );
    }
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
    lines.push(`    ${account.name}${hubIds.includes(account.id) ? " (hub)" : ""}: ${money(balance)}`);
  }
  lines.push(`  net worth ${money(snapshot.netWorthNominal)} (real ${money(snapshot.netWorthReal)})`);

  return lines.join("\n");
}
