"use client";

import { Fragment, useMemo, useState } from "react";
import type { Account, CashFlowLineItem, TaxTreatment, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";

const TAX_GROUPS: { key: TaxTreatment; label: string }[] = [
  { key: "taxable", label: "Taxable" },
  { key: "tax_deferred", label: "Tax-deferred" },
  { key: "tax_free", label: "Tax-free" },
  { key: "n/a", label: "Cash & Other" },
];

/** Union of line-item ids across all visible years, ordered by total magnitude. */
function unionItems(perYear: CashFlowLineItem[][]): { id: string; label: string }[] {
  const labels = new Map<string, string>();
  const totals = new Map<string, number>();
  for (const arr of perYear) {
    for (const it of arr) {
      labels.set(it.id, it.label);
      totals.set(it.id, (totals.get(it.id) ?? 0) + it.amount);
    }
  }
  return [...labels.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0));
}

function ToggleLabel({ label, expanded, onToggle }: { label: string; expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-1 text-left">
      <span className="inline-block w-3 text-dim">{expanded ? "▾" : "▸"}</span>
      {label}
    </button>
  );
}

export function CashFlowTable({
  years,
  accounts,
  dollarMode,
}: {
  years: YearSnapshot[];
  accounts: Account[];
  dollarMode: DollarMode;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const isOpen = (key: string) => expanded.has(key);

  // Deflate a nominal figure for the given visible-year index when in real mode.
  const d = (value: number, yearIndex: number) =>
    dollarMode === "real" ? value / years[yearIndex].inflationDeflator : value;

  const taxOf = useMemo(() => {
    const m = new Map<string, TaxTreatment>();
    for (const a of accounts) m.set(a.id, a.taxTreatment ?? "n/a");
    return m;
  }, [accounts]);

  // Per-year id→amount lookup maps + union id lists for each drill-down section.
  const incomeMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.incomeByItem.map((i) => [i.id, i.amount]))), [years]);
  const expenseMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.expenseByItem.map((i) => [i.id, i.amount]))), [years]);
  const contribMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.contributionsByItem.map((i) => [i.id, i.amount]))), [years]);
  const surplusMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.surplusByAccount.map((i) => [i.id, i.amount]))), [years]);
  const withdrawalMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.withdrawalsByAccount.map((i) => [i.id, i.amount]))), [years]);
  const rmdMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.rmdByAccount.map((i) => [i.id, i.amount]))), [years]);

  const incomeItems = useMemo(() => unionItems(years.map((y) => y.cashFlow.incomeByItem)), [years]);
  const expenseItems = useMemo(() => unionItems(years.map((y) => y.cashFlow.expenseByItem)), [years]);
  const contribItems = useMemo(() => {
    const fromPay = new Map<string, boolean>();
    for (const y of years) for (const c of y.cashFlow.contributionsByItem) fromPay.set(c.id, c.fromPaycheck);
    return unionItems(years.map((y) => y.cashFlow.contributionsByItem)).map((it) => ({ ...it, fromPaycheck: fromPay.get(it.id) ?? false }));
  }, [years]);
  const surplusItems = useMemo(() => unionItems(years.map((y) => y.cashFlow.surplusByAccount)), [years]);
  const rmdItems = useMemo(() => unionItems(years.map((y) => y.cashFlow.rmdByAccount)), [years]);

  // Withdrawal source accounts, grouped by tax treatment (only groups with data).
  const withdrawalGroups = useMemo(() => {
    const items = unionItems(years.map((y) => y.cashFlow.withdrawalsByAccount));
    return TAX_GROUPS.map((g) => ({
      ...g,
      accounts: items.filter((it) => (taxOf.get(it.id) ?? "n/a") === g.key),
    })).filter((g) => g.accounts.length > 0);
  }, [years, taxOf]);

  const hasRmd = rmdItems.length > 0;
  const hasTax = years.some((y) => y.cashFlow.withdrawalTaxes > 0.005);

  if (years.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel p-8 text-center text-sm text-dim">
        No years in the selected range.
      </div>
    );
  }

  const col = years.length + 2; // label + each visible year + total

  // Sum of a row's deflated per-year values across the selected range.
  const totalOf = (get: (yi: number) => number) => years.reduce((s, _y, yi) => s + d(get(yi), yi), 0);

  const totalCellClass = "py-1.5 pr-3 text-right tabular-nums border-l border-border bg-background/40 font-medium";

  const totalCell = (v: number, opts?: { signed?: boolean }) => (
    <td className={totalCellClass}>
      {opts?.signed ? (
        <span className={v < 0 ? "text-negative" : v > 0 ? "text-positive" : "text-dim"}>{formatMoney(v)}</span>
      ) : Math.abs(v) < 0.5 ? (
        <span className="text-dim">—</span>
      ) : (
        formatMoney(v)
      )}
    </td>
  );

  // Money cells across every visible year plus a trailing total, deflated as needed.
  const cells = (get: (yi: number) => number) => (
    <>
      {years.map((y, yi) => {
        const v = d(get(yi), yi);
        return (
          <td key={y.year} className="py-1.5 pr-3 text-right tabular-nums">
            {Math.abs(v) < 0.5 ? <span className="text-dim">—</span> : formatMoney(v)}
          </td>
        );
      })}
      {totalCell(totalOf(get))}
    </>
  );

  const summaryRow = (label: string, get: (yi: number) => number, opts?: { totalIsMeaningful?: boolean }) => (
    <tr className="border-t border-border">
      <td className="py-2 pl-2 font-bold">{label}</td>
      {years.map((y, yi) => {
        const v = d(get(yi), yi);
        return (
          <td key={y.year} className="py-1.5 pr-3 text-right tabular-nums">
            <span className={v < 0 ? "text-negative" : v > 0 ? "text-positive" : "text-dim"}>{formatMoney(v)}</span>
          </td>
        );
      })}
      {opts?.totalIsMeaningful === false ? (
        <td className={totalCellClass}>
          <span className="text-dim" title="A point-in-time balance isn't meaningful to sum across years">
            —
          </span>
        </td>
      ) : (
        totalCell(totalOf(get), { signed: true })
      )}
    </tr>
  );

  // Taxes are always a cost, so this row is red regardless of sign convention
  // (unlike summaryRow's signed cells, which would show a positive tax amount in green).
  const taxRow = (label: string, get: (yi: number) => number) => (
    <tr className="border-t border-border text-negative">
      <td className="py-2 pl-2 font-bold">{label}</td>
      {years.map((y, yi) => {
        const v = d(get(yi), yi);
        return (
          <td key={y.year} className="py-1.5 pr-3 text-right tabular-nums">
            {Math.abs(v) < 0.5 ? <span className="text-dim">—</span> : formatMoney(v)}
          </td>
        );
      })}
      <td className={`${totalCellClass} text-negative`}>{formatMoney(totalOf(get))}</td>
    </tr>
  );

  const sectionHeader = (key: string, label: string, get: (yi: number) => number) => (
    <tr className="border-t border-border bg-background/40">
      <td className="py-2 pl-2 font-semibold">
        <ToggleLabel label={label} expanded={isOpen(key)} onToggle={() => toggle(key)} />
      </td>
      {cells(get)}
    </tr>
  );

  const itemRows = (items: { id: string; label: string }[], maps: Map<string, number>[], indent = "pl-10") =>
    items.map((item) => (
      <tr key={item.id} className="text-dim hover:bg-background/40">
        <td className={`py-1.5 ${indent}`}>{item.label}</td>
        {cells((yi) => maps[yi].get(item.id) ?? 0)}
      </tr>
    ));

  const emptyRow = (text: string) => (
    <tr className="text-xs text-dim">
      <td className="py-1.5 pl-10" colSpan={col}>
        {text}
      </td>
    </tr>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-panel">
        <table className="w-full text-xs tabular-nums [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:border-b [&_thead_th]:border-border [&_thead_th]:bg-panel [&_thead_th:not(:first-child)]:z-20 [&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10 [&_tbody_td:first-child]:border-r [&_tbody_td:first-child]:border-border [&_tbody_td:first-child]:bg-panel [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
          <thead>
            <tr className="text-left text-xs text-dim">
              <th className="sticky left-0 top-0 z-30 border-b border-r border-border bg-panel py-2 pl-2 font-medium">Category</th>
              {years.map((y) => (
                <th key={y.year} className="py-2 pr-3 text-right font-medium">
                  {y.year}
                </th>
              ))}
              <th className="border-l border-border bg-background/40 py-2 pr-3 text-right font-medium">
                Total ({years[0].year}–{years[years.length - 1].year})
              </th>
            </tr>
          </thead>
          <tbody>
            {summaryRow("Net Cash Flow", (yi) => years[yi].cashFlow.netCashFlow)}

            {sectionHeader("income", "Income", (yi) => years[yi].cashFlow.totalIncome)}
            {isOpen("income") && (incomeItems.length ? itemRows(incomeItems, incomeMaps) : emptyRow("No income in this range."))}

            {sectionHeader("expenses", "Expenses", (yi) => years[yi].cashFlow.totalExpenses)}
            {isOpen("expenses") && (expenseItems.length ? itemRows(expenseItems, expenseMaps) : emptyRow("No expenses in this range."))}

            {sectionHeader("contributions", "Contributions (from take-home)", (yi) => years[yi].cashFlow.afterTaxContributionTotal)}
            {isOpen("contributions") &&
              (contribItems.length
                ? contribItems.map((item) => (
                    <tr key={item.id} className={`hover:bg-background/40 ${item.fromPaycheck ? "text-dim/60" : "text-dim"}`}>
                      <td className="py-1.5 pl-10">
                        {item.label}
                        {item.fromPaycheck && <span className="ml-2 text-xs italic">from paycheck</span>}
                      </td>
                      {cells((yi) => contribMaps[yi].get(item.id) ?? 0)}
                    </tr>
                  ))
                : emptyRow("No contributions in this range."))}

            {sectionHeader("surplus", "Surplus routed to accounts", (yi) => years[yi].cashFlow.surplusRouted)}
            {isOpen("surplus") &&
              (surplusItems.length ? itemRows(surplusItems, surplusMaps) : emptyRow("No surplus routed in this range."))}

            {sectionHeader("withdrawals", "Withdrawals (to cover shortfalls)", (yi) => years[yi].cashFlow.deficitCovered)}
            {isOpen("withdrawals") &&
              (withdrawalGroups.length
                ? withdrawalGroups.map((g) => (
                    <Fragment key={g.key}>
                      <tr className="text-dim">
                        <td className="py-1.5 pl-6 font-medium">{g.label}</td>
                        {cells((yi) => g.accounts.reduce((s, a) => s + (withdrawalMaps[yi].get(a.id) ?? 0), 0))}
                      </tr>
                      {itemRows(g.accounts, withdrawalMaps, "pl-12")}
                    </Fragment>
                  ))
                : emptyRow("No shortfall withdrawals in this range."))}

            {hasRmd && sectionHeader("rmd", "Required distributions (RMDs)", (yi) => years[yi].cashFlow.rmdTotal)}
            {hasRmd && isOpen("rmd") && itemRows(rmdItems, rmdMaps)}

            {hasTax && taxRow("Taxes on withdrawals & RMDs", (yi) => years[yi].cashFlow.withdrawalTaxes)}

            {summaryRow("Ending Cash", (yi) => years[yi].cashFlow.endingCashBalance, { totalIsMeaningful: false })}
          </tbody>
        </table>
      </div>
      <p className="px-1 text-xs text-dim">
        Net Cash Flow = income − (expenses + take-home contributions + withdrawal/RMD taxes). In a positive year the leftover is routed into your
        accounts; in a short year it&apos;s withdrawn from them (grouped by tax treatment). Paycheck-deducted contributions (shown
        greyed, e.g. a 401k or Roth 401k) grow your accounts but aren&apos;t drawn from take-home pay, so they aren&apos;t in the total. The
        Total column sums each row across the selected year range (in whichever dollar mode is active); Ending Cash is a balance, not a
        flow, so it isn&apos;t summed.
      </p>
    </div>
  );
}
