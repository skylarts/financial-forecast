"use client";

import { Fragment, useMemo, useState } from "react";
import type { Account, CashFlowLineItem, FederalTaxComponentKey, TaxTreatment, WithdrawalLineItem, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { InfoTooltip } from "@/components/ui/formFields";

// Fixed display order for the federal tax breakdown -- matches the order
// components are computed in the engine, and stays stable across years
// (rather than re-sorting by magnitude, which would shuffle row order as the
// tax-deferred/pension/SS split shifts from year to year).
const FEDERAL_TAX_COMPONENT_ORDER: FederalTaxComponentKey[] = [
  "tax_deferred",
  "pension",
  "taxable_social_security",
  "capital_gains",
  "state_local",
];

// Order the withdrawal groups Cash first, then by tax character.
const TAX_GROUPS: { key: TaxTreatment; label: string }[] = [
  { key: "n/a", label: "Cash & Other" },
  { key: "taxable", label: "Taxable investments" },
  { key: "tax_deferred", label: "Tax-deferred (401k / IRA)" },
  { key: "tax_free", label: "Tax-free (Roth)" },
];

/**
 * Union of line-item ids across all visible years. Ordered by total
 * magnitude by default, or chronologically by each item's real first-posted
 * date (items with no known date sort last) when sortBy = "date".
 */
function unionItems(
  perYear: CashFlowLineItem[][],
  sortBy: "magnitude" | "date" = "magnitude"
): { id: string; label: string }[] {
  const labels = new Map<string, string>();
  const totals = new Map<string, number>();
  const firstDates = new Map<string, string | null>();
  for (const arr of perYear) {
    for (const it of arr) {
      labels.set(it.id, it.label);
      totals.set(it.id, (totals.get(it.id) ?? 0) + it.amount);
      if (!firstDates.has(it.id)) firstDates.set(it.id, it.startDate);
    }
  }
  const items = [...labels.entries()].map(([id, label]) => ({ id, label }));
  if (sortBy === "date") {
    return items.sort((a, b) => {
      const da = firstDates.get(a.id);
      const db = firstDates.get(b.id);
      if (da && db) return da < db ? -1 : da > db ? 1 : 0;
      if (da) return -1;
      if (db) return 1;
      return 0;
    });
  }
  return items.sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0));
}

/** Union of withdrawal source accounts across visible years, with tax treatment, by gross magnitude. */
function unionWithdrawals(perYear: WithdrawalLineItem[][]): { id: string; label: string; taxTreatment: TaxTreatment }[] {
  const meta = new Map<string, { label: string; taxTreatment: TaxTreatment }>();
  const totals = new Map<string, number>();
  for (const arr of perYear) {
    for (const w of arr) {
      meta.set(w.id, { label: w.label, taxTreatment: w.taxTreatment });
      totals.set(w.id, (totals.get(w.id) ?? 0) + w.gross);
    }
  }
  return [...meta.entries()]
    .map(([id, m]) => ({ id, ...m }))
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
  void accounts; // account metadata now travels on each WithdrawalLineItem
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const isOpen = (key: string) => expanded.has(key);

  // Deflate a nominal FLOW for the given visible-year index when in real mode.
  // Flows happen throughout the year, so they use the mid-year flow deflator;
  // the ending-balance row uses the year-end balance deflator instead.
  const d = (value: number, yearIndex: number) =>
    dollarMode === "real" ? value / (years[yearIndex].flowInflationDeflator ?? years[yearIndex].inflationDeflator) : value;
  const dBalance = (value: number, yearIndex: number) =>
    dollarMode === "real" ? value / years[yearIndex].inflationDeflator : value;

  // Per-year id→amount lookup maps + union id lists for each drill-down section.
  const incomeMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.incomeByItem.map((i) => [i.id, i.amount]))), [years]);
  const expenseMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.expenseByItem.map((i) => [i.id, i.amount]))), [years]);
  const contribMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.contributionsByItem.map((i) => [i.id, i.amount]))), [years]);
  const surplusMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.surplusByAccount.map((i) => [i.id, i.amount]))), [years]);
  const wdGrossMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.withdrawalsByAccount.map((w) => [w.id, w.gross]))), [years]);
  const wdTaxMaps = useMemo(() => years.map((y) => new Map(y.cashFlow.withdrawalsByAccount.map((w) => [w.id, w.tax]))), [years]);

  const incomeItems = useMemo(() => unionItems(years.map((y) => y.cashFlow.incomeByItem), "date"), [years]);
  const expenseItems = useMemo(() => unionItems(years.map((y) => y.cashFlow.expenseByItem), "date"), [years]);
  const contribItems = useMemo(() => {
    const fromPay = new Map<string, boolean>();
    for (const y of years) for (const c of y.cashFlow.contributionsByItem) fromPay.set(c.id, c.fromPaycheck);
    return unionItems(years.map((y) => y.cashFlow.contributionsByItem)).map((it) => ({ ...it, fromPaycheck: fromPay.get(it.id) ?? false }));
  }, [years]);
  const surplusItems = useMemo(() => unionItems(years.map((y) => y.cashFlow.surplusByAccount)), [years]);
  const otherActivityMaps = useMemo(
    () => years.map((y) => new Map(y.cashFlow.otherActivityByItem.map((i) => [i.id, i.amount]))),
    [years]
  );
  const otherActivityItems = useMemo(() => unionItems(years.map((y) => y.cashFlow.otherActivityByItem), "date"), [years]);

  // Federal tax breakdown -- shown as negative (a deduction), same sign convention as the summary row above it.
  const federalTaxComponentMaps = useMemo(
    () => years.map((y) => new Map(y.cashFlow.federalTaxByComponent.map((c) => [c.key, -c.amount]))),
    [years]
  );
  const federalTaxComponentItems = useMemo(() => {
    const labels = new Map<string, string>();
    for (const y of years) for (const c of y.cashFlow.federalTaxByComponent) labels.set(c.key, c.label);
    return FEDERAL_TAX_COMPONENT_ORDER.filter((k) => labels.has(k)).map((k) => ({ id: k, label: `${labels.get(k)} (actual)` }));
  }, [years]);

  // Withdrawal source accounts, grouped by tax treatment (only groups with data).
  const withdrawalGroups = useMemo(() => {
    const items = unionWithdrawals(years.map((y) => y.cashFlow.withdrawalsByAccount));
    return TAX_GROUPS.map((g) => ({ ...g, accounts: items.filter((it) => it.taxTreatment === g.key) })).filter(
      (g) => g.accounts.length > 0
    );
  }, [years]);

  const hasWithdrawals = withdrawalGroups.length > 0;
  const hasSaved = years.some((y) => y.cashFlow.afterTaxContributionTotal + y.cashFlow.surplusRouted > 0.005);
  const hasCashInterest = years.some((y) => Math.abs(y.cashFlow.cashInterest) > 0.5);
  const hasBenefitWithholding = years.some((y) => Math.abs(y.cashFlow.incomeTaxWithheldFromCash) > 0.5);
  const hasSettlement = years.some((y) => Math.abs(y.cashFlow.taxSettlement) > 0.5);
  const hasOtherActivity = years.some((y) => Math.abs(y.cashFlow.otherAccountActivity) > 0.5);
  const hasFederalTax = years.some((y) => y.cashFlow.federalTaxTotal > 0.5);

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

  const totalCellClass = "py-2 pr-3 text-right tabular-nums bg-background/40 font-medium";

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
          <td key={y.year} className="py-2 pr-3 text-right tabular-nums">
            {Math.abs(v) < 0.5 ? <span className="text-dim">—</span> : formatMoney(v)}
          </td>
        );
      })}
      {totalCell(totalOf(get))}
    </>
  );

  const summaryRow = (
    label: string,
    get: (yi: number) => number,
    opts?: { totalIsMeaningful?: boolean; strong?: boolean; hint?: string; balance?: boolean }
  ) => (
    <tr className={`border-t border-border ${opts?.strong ? "bg-background/40" : ""}`}>
      <td className="py-2.5 pl-2 font-bold">
        <span className="inline-flex items-center gap-1">
          {label}
          {opts?.hint && <InfoTooltip text={opts.hint} />}
        </span>
      </td>
      {years.map((y, yi) => {
        const v = opts?.balance ? dBalance(get(yi), yi) : d(get(yi), yi);
        return (
          <td key={y.year} className="py-2 pr-3 text-right font-semibold tabular-nums">
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

  // A plain reconciling line item (signed, dimmer than a summary row).
  const reconcileRow = (label: string, get: (yi: number) => number, hint?: string) => (
    <tr className="text-dim hover:bg-accent/15">
      <td className="py-2 pl-2">
        <span className="inline-flex items-center gap-1">
          {label}
          {hint && <InfoTooltip text={hint} />}
        </span>
      </td>
      {years.map((y, yi) => {
        const v = d(get(yi), yi);
        return (
          <td key={y.year} className="py-2 pr-3 text-right tabular-nums">
            {Math.abs(v) < 0.5 ? (
              <span className="text-dim">—</span>
            ) : (
              <span className={v < 0 ? "text-negative" : ""}>{formatMoney(v)}</span>
            )}
          </td>
        );
      })}
      {totalCell(totalOf(get), { signed: true })}
    </tr>
  );

  const sectionHeader = (key: string, label: string, get: (yi: number) => number, hint?: string) => (
    <tr className="border-t border-border bg-background/40">
      <td className="py-2.5 pl-2 font-semibold">
        <span className="inline-flex items-center gap-1">
          <ToggleLabel label={label} expanded={isOpen(key)} onToggle={() => toggle(key)} />
          {hint && <InfoTooltip text={hint} />}
        </span>
      </td>
      {cells(get)}
    </tr>
  );

  const itemRows = (items: { id: string; label: string }[], maps: Map<string, number>[], indent = "pl-10") =>
    items.map((item) => (
      <tr key={item.id} className="text-dim hover:bg-accent/15">
        <td className={`py-2 ${indent}`}>{item.label}</td>
        {cells((yi) => maps[yi].get(item.id) ?? 0)}
      </tr>
    ));

  const emptyRow = (text: string) => (
    <tr className="text-xs text-dim">
      <td className="py-2 pl-10" colSpan={col}>
        {text}
      </td>
    </tr>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[85vh] overflow-auto rounded-lg border border-border bg-panel">
        <table className="w-full text-sm tabular-nums [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:border-b [&_thead_th]:border-border [&_thead_th]:bg-panel [&_thead_th:not(:first-child)]:z-20 [&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10 [&_tbody_td:first-child]:bg-panel [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
          <thead>
            <tr className="text-left text-xs text-dim">
              <th className="sticky left-0 top-0 z-30 border-b border-border bg-panel py-2.5 pl-2 font-medium">Category</th>
              {years.map((y) => (
                <th key={y.year} className="py-2.5 pr-3 text-right font-medium">
                  {y.year}
                </th>
              ))}
              <th className="bg-background/40 py-2.5 pr-3 text-right font-medium">
                Total ({years[0].year}–{years[years.length - 1].year})
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Income */}
            {sectionHeader("income", "Income", (yi) => years[yi].cashFlow.totalIncome)}
            {isOpen("income") && (incomeItems.length ? itemRows(incomeItems, incomeMaps) : emptyRow("No income in this range."))}

            {/* Expenses */}
            {sectionHeader("expenses", "Expenses", (yi) => years[yi].cashFlow.totalExpenses)}
            {isOpen("expenses") && (expenseItems.length ? itemRows(expenseItems, expenseMaps) : emptyRow("No expenses in this range."))}

            {/* Operating surplus / (shortfall) */}
            {summaryRow("Operating surplus / (shortfall)", (yi) => years[yi].cashFlow.operatingCashFlow, {
              strong: true,
              hint: "Income minus expenses. When it goes negative (typically once income drops in retirement), Withdrawals below pull from your accounts to cover it.",
            })}

            {/* Withdrawals -- header shows the NET amount that actually reached
                cash (what the reconciliation needs); the drill-down below shows
                each source account GROSS with its estimated withholding. */}
            {sectionHeader(
              "withdrawals",
              "Withdrawals (net to cash)",
              (yi) => years[yi].cashFlow.withdrawalsToCashNet,
              "Money pulled from your accounts that actually reached your spending: planned drawdowns and RMDs, net of tax withheld at the source. Expand to see each account's GROSS withdrawal (net + estimated withholding) -- so the expanded rows intentionally total more than this line. A transfer between your own accounts also appears in the breakdown for visibility."
            )}
            {isOpen("withdrawals") &&
              (hasWithdrawals
                ? withdrawalGroups.map((g) => (
                    <Fragment key={g.key}>
                      <tr className="text-dim hover:bg-accent/15">
                        <td className="py-2 pl-6 font-medium">
                          <ToggleLabel
                            label={g.label}
                            expanded={isOpen(`wd:${g.key}`)}
                            onToggle={() => toggle(`wd:${g.key}`)}
                          />
                        </td>
                        {cells((yi) => g.accounts.reduce((s, a) => s + (wdGrossMaps[yi].get(a.id) ?? 0), 0))}
                      </tr>
                      {isOpen(`wd:${g.key}`) &&
                      g.accounts.map((a) => (
                        <Fragment key={a.id}>
                          <tr className="text-dim hover:bg-accent/15">
                            <td className="py-2 pl-12">{a.label}</td>
                            {cells((yi) => wdGrossMaps[yi].get(a.id) ?? 0)}
                          </tr>
                          {years.some((_y, yi) => (wdTaxMaps[yi].get(a.id) ?? 0) > 0.5) && (
                            <tr className="text-negative/80 hover:bg-accent/15">
                              <td className="py-1 pl-16 text-xs italic">estimated withholding</td>
                              {years.map((y, yi) => {
                                const v = d(wdTaxMaps[yi].get(a.id) ?? 0, yi);
                                return (
                                  <td key={y.year} className="py-1 pr-3 text-right text-xs tabular-nums">
                                    {Math.abs(v) < 0.5 ? <span className="text-dim">—</span> : formatMoney(v)}
                                  </td>
                                );
                              })}
                              <td className={`${totalCellClass} text-xs`}>
                                {formatMoney(totalOf((yi) => wdTaxMaps[yi].get(a.id) ?? 0))}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </Fragment>
                  ))
                : emptyRow("No withdrawals in this range."))}

            {/* Cash-side tax rows: withholding taken from benefit deposits, and
                the December true-up that settles withholding onto the exact
                bracket bill. Together with the net Withdrawals line above,
                these make the visible rows sum exactly to Net change in cash. */}
            {hasBenefitWithholding &&
              reconcileRow(
                "Tax withheld on benefits",
                (yi) => -years[yi].cashFlow.incomeTaxWithheldFromCash,
                "Estimated tax withheld from Social Security / pension deposits before they reach your cash (both are entered gross)."
              )}
            {hasSettlement &&
              reconcileRow(
                "Tax true-up (year-end settlement)",
                (yi) => years[yi].cashFlow.taxSettlement,
                "Each December the estimated withholding is settled against the exact bracket-computed bill -- positive is a refund back into cash, negative is extra tax owed. After this, the year's actual cash tax equals the Federal tax line below exactly."
              )}

            {/* Saved to accounts */}
            {hasSaved &&
              sectionHeader(
                "saved",
                "Saved to accounts",
                (yi) => years[yi].cashFlow.afterTaxContributionTotal + years[yi].cashFlow.surplusRouted
              )}
            {hasSaved && isOpen("saved") && (
              <>
                {surplusItems.length > 0 && (
                  <tr className="text-dim hover:bg-accent/15">
                    <td className="py-2 pl-10 font-medium">Surplus swept to savings/investments</td>
                    {cells((yi) => years[yi].cashFlow.surplusRouted)}
                  </tr>
                )}
                {itemRows(surplusItems, surplusMaps, "pl-14")}
                {contribItems.map((item) => (
                  <tr key={item.id} className={`hover:bg-accent/15 ${item.fromPaycheck ? "text-dim/60" : "text-dim"}`}>
                    <td className="py-2 pl-10">
                      {item.label}
                      {item.fromPaycheck && <span className="ml-2 text-xs italic">from paycheck</span>}
                    </td>
                    {cells((yi) => contribMaps[yi].get(item.id) ?? 0)}
                  </tr>
                ))}
              </>
            )}

            {/* Interest earned directly on cash, and any direct hub activity
                (a down payment from cash, home-sale proceeds, a custom
                transfer touching the hub) -- shown whenever present so the
                visible rows always sum exactly to the bottom line. */}
            {hasCashInterest && (
              <tr className="text-dim hover:bg-accent/15">
                <td className="py-2 pl-2">Interest earned on cash</td>
                {cells((yi) => years[yi].cashFlow.cashInterest)}
              </tr>
            )}
            {hasOtherActivity && (
              <>
                <tr className="text-dim hover:bg-accent/15">
                  <td className="py-2 pl-2">
                    <span className="inline-flex items-center gap-1">
                      <ToggleLabel
                        label="Other account activity"
                        expanded={isOpen("otherActivity")}
                        onToggle={() => toggle("otherActivity")}
                      />
                      <InfoTooltip text="One-off flows that touched cash directly: a home purchase down payment, home-sale proceeds, a custom transfer to/from the hub, net of income deposited straight into an investment. Expand to see each flow." />
                    </span>
                  </td>
                  {years.map((y, yi) => {
                    const v = d(years[yi].cashFlow.otherAccountActivity, yi);
                    return (
                      <td key={y.year} className="py-2 pr-3 text-right tabular-nums">
                        {Math.abs(v) < 0.5 ? (
                          <span className="text-dim">—</span>
                        ) : (
                          <span className={v < 0 ? "text-negative" : ""}>{formatMoney(v)}</span>
                        )}
                      </td>
                    );
                  })}
                  {totalCell(totalOf((yi) => years[yi].cashFlow.otherAccountActivity), { signed: true })}
                </tr>
                {isOpen("otherActivity") &&
                  otherActivityItems.map((item) => (
                    <tr key={item.id} className="text-dim hover:bg-accent/15">
                      <td className="py-2 pl-10">{item.label}</td>
                      {years.map((y, yi) => {
                        const v = d(otherActivityMaps[yi].get(item.id) ?? 0, yi);
                        return (
                          <td key={y.year} className="py-2 pr-3 text-right tabular-nums">
                            {Math.abs(v) < 0.5 ? (
                              <span className="text-dim">—</span>
                            ) : (
                              <span className={v < 0 ? "text-negative" : ""}>{formatMoney(v)}</span>
                            )}
                          </td>
                        );
                      })}
                      {totalCell(totalOf((yi) => otherActivityMaps[yi].get(item.id) ?? 0), { signed: true })}
                    </tr>
                  ))}
              </>
            )}
            {/* Net change in cash -- the reconciling bottom line. Always exactly
                equals every row above summed, because it's measured directly
                from the actual simulated cash balance, not derived from them. */}
            {summaryRow("Net change in cash", (yi) => years[yi].cashFlow.netCashFlow, {
              strong: true,
              hint: "The measured change in Extra Savings' balance this year -- exactly the sum of the rows above: operating result, net withdrawals, tax rows, saving, interest, and other activity. Lands near $0 in a year where you draw just what you need.",
            })}
            {summaryRow("Ending cash on hand", (yi) => years[yi].cashFlow.endingCashBalance, {
              totalIsMeaningful: false,
              balance: true,
              hint: "Your total balance across all cash accounts, not just Extra Savings -- a broader figure than the reconciliation above. Not summed in the Total column since it's a balance, not a flow.",
            })}

            {/* Federal tax -- informational: the exact bracket-computed bill for
                the year. Thanks to the true-up row above, this IS the cash tax
                the household actually paid for the year; it's shown separately
                (not part of the reconciliation sum) because most of it was
                withheld at the source accounts, not from cash. */}
            {hasFederalTax && (
              <>
                <tr className="border-t-2 border-border bg-background/40">
                  <td className="py-2.5 pl-2 font-bold" colSpan={col}>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
                      Taxes (informational)
                      <InfoTooltip text="Not part of the cash reconciliation above -- most tax is withheld inside the source accounts (it shows up in each account's gross withdrawal), with the year-end true-up settling the difference into cash." />
                    </span>
                  </td>
                </tr>
                <tr className="border-t border-border">
                  <td className="py-2.5 pl-2 font-bold">
                    <span className="inline-flex items-center gap-1">
                      <ToggleLabel label="Federal tax (actual bill)" expanded={isOpen("federalTax")} onToggle={() => toggle("federalTax")} />
                      <InfoTooltip text="The exact bill for the year from real IRS brackets on actual realized income -- and, after the year-end true-up, exactly what the household actually paid. Expand to see which income sources it came from." />
                    </span>
                  </td>
                  {years.map((y, yi) => {
                    const v = d(-years[yi].cashFlow.federalTaxTotal, yi);
                    return (
                      <td key={y.year} className="py-2 pr-3 text-right font-semibold tabular-nums">
                        <span className={v < 0 ? "text-negative" : v > 0 ? "text-positive" : "text-dim"}>{formatMoney(v)}</span>
                      </td>
                    );
                  })}
                  {totalCell(totalOf((yi) => -years[yi].cashFlow.federalTaxTotal), { signed: true })}
                </tr>
                {isOpen("federalTax") &&
                  (federalTaxComponentItems.length
                    ? itemRows(federalTaxComponentItems, federalTaxComponentMaps)
                    : emptyRow("No federal tax in this range."))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
