"use client";

import { Fragment, useMemo, useState } from "react";
import type {
  Account,
  CashFlowLineItem,
  FederalTaxComponentKey,
  Granularity,
  PeriodSnapshot,
  TaxTreatment,
  WithdrawalLineItem,
} from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { InfoTooltip } from "@/components/ui/formFields";
import { useUiStore } from "@/store/useUiStore";

// Fixed display order for the federal tax breakdown -- matches the order
// components are computed in the engine, and stays stable across periods
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
 * Union of line-item ids across all visible periods. Ordered by total
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

/** Union of withdrawal source accounts across visible periods, with tax treatment, by gross magnitude. */
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
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="flex items-center gap-1 text-left"
    >
      <span className="inline-block w-3 text-dim">{expanded ? "▾" : "▸"}</span>
      {label}
    </button>
  );
}

export function CashFlowTable({
  periods,
  accounts,
  dollarMode,
  granularity,
}: {
  /** One column per period -- calendar years or months, depending on `granularity`. */
  periods: PeriodSnapshot[];
  accounts: Account[];
  dollarMode: DollarMode;
  granularity: Granularity;
}) {
  const isMonthly = granularity === "month";
  // Every section starts collapsed. "Taxes" is the exception -- its expand
  // state is remembered across reloads/sign-ins (see useUiStore) rather than
  // reset each visit, since it's a section people either always or never care
  // about drilling into.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const taxesOpen = useUiStore((s) => s.cashFlowTaxesOpen);
  const setTaxesOpen = useUiStore((s) => s.setCashFlowTaxesOpen);
  const toggle = (key: string) => {
    if (key === "taxes") {
      setTaxesOpen(!taxesOpen);
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const isOpen = (key: string) => (key === "taxes" ? taxesOpen : expanded.has(key));

  // Column highlight state -- see colHoverProps/colHoverClass below.
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  // Deflate a nominal FLOW for the given visible-year index when in real mode.
  // Flows happen throughout the year, so they use the mid-year flow deflator;
  // the ending-balance row uses the year-end balance deflator instead.
  const d = (value: number, yearIndex: number) =>
    dollarMode === "real" ? value / (periods[yearIndex].flowInflationDeflator ?? periods[yearIndex].inflationDeflator) : value;
  const dBalance = (value: number, yearIndex: number) =>
    dollarMode === "real" ? value / periods[yearIndex].inflationDeflator : value;

  // Per-year id→amount lookup maps + union id lists for each drill-down section.
  const incomeMaps = useMemo(() => periods.map((y) => new Map(y.cashFlow.incomeByItem.map((i) => [i.id, i.amount]))), [periods]);
  const expenseMaps = useMemo(() => periods.map((y) => new Map(y.cashFlow.expenseByItem.map((i) => [i.id, i.amount]))), [periods]);
  const contribMaps = useMemo(() => periods.map((y) => new Map(y.cashFlow.contributionsByItem.map((i) => [i.id, i.amount]))), [periods]);
  const surplusMaps = useMemo(() => periods.map((y) => new Map(y.cashFlow.surplusByAccount.map((i) => [i.id, i.amount]))), [periods]);
  const wdGrossMaps = useMemo(() => periods.map((y) => new Map(y.cashFlow.withdrawalsByAccount.map((w) => [w.id, w.gross]))), [periods]);
  const wdTaxMaps = useMemo(() => periods.map((y) => new Map(y.cashFlow.withdrawalsByAccount.map((w) => [w.id, w.tax]))), [periods]);

  const incomeItems = useMemo(() => unionItems(periods.map((y) => y.cashFlow.incomeByItem), "date"), [periods]);
  const expenseItems = useMemo(() => unionItems(periods.map((y) => y.cashFlow.expenseByItem), "date"), [periods]);
  const contribItems = useMemo(() => {
    const fromPay = new Map<string, boolean>();
    for (const y of periods) for (const c of y.cashFlow.contributionsByItem) fromPay.set(c.id, c.fromPaycheck);
    return unionItems(periods.map((y) => y.cashFlow.contributionsByItem)).map((it) => ({ ...it, fromPaycheck: fromPay.get(it.id) ?? false }));
  }, [periods]);
  // otherActivityByItem grouped by its counterparty account (falling back to
  // a synthetic "__other__" bucket for flows with no single account, e.g. a
  // reconciling residual) -- folded into Account Activity below instead of
  // living in its own section.
  const otherActivityMapsByAccount = useMemo(
    () =>
      periods.map((y) => {
        const m = new Map<string, number>();
        for (const it of y.cashFlow.otherActivityByItem) {
          const key = it.accountId ?? "__other__";
          m.set(key, (m.get(key) ?? 0) + it.amount);
        }
        return m;
      }),
    [periods]
  );

  // Expenses grouped by source: a life event's one-time + recurring costs
  // collapse under one expandable row (ids share the event-id prefix, e.g.
  // "evt1:onetime" / "evt1:childcare"), and a home's mortgage payment +
  // ownership costs (property tax, insurance, maintenance) collapse under
  // the home's name (linked via the real-estate account's linkedLiabilityId).
  // Items that don't belong to a multi-item group render as plain rows.
  const expenseGroups = useMemo(() => {
    // itemId -> forced group key for home-related items.
    const homeGroupOf = new Map<string, string>();
    const homeLabels = new Map<string, string>();
    for (const a of accounts) {
      if (a.class !== "real_estate") continue;
      const key = `home:${a.id}`;
      homeLabels.set(key, a.name);
      homeGroupOf.set(`${a.id}:ownership_costs`, key);
      if (a.linkedLiabilityId) homeGroupOf.set(a.linkedLiabilityId, key);
    }
    // Bucket every expense item, preserving expenseItems' (date) order.
    const buckets = new Map<string, { label: string | null; items: { id: string; label: string }[] }>();
    const order: string[] = [];
    for (const it of expenseItems) {
      const home = homeGroupOf.get(it.id);
      const colon = it.id.indexOf(":");
      const key = home ?? (colon > 0 ? `evt:${it.id.slice(0, colon)}` : `solo:${it.id}`);
      if (!buckets.has(key)) {
        buckets.set(key, { label: home ? homeLabels.get(home) ?? null : null, items: [] });
        order.push(key);
      }
      buckets.get(key)!.items.push(it);
    }
    return order.map((key) => {
      const b = buckets.get(key)!;
      if (b.items.length < 2) return { key, label: b.items[0].label, items: b.items, grouped: false };
      // Event group label = the shared event name after ": " in child labels
      // ("Childcare: Have a kid" -> "Have a kid"); children then show just
      // their own part ("Childcare"). Homes keep their account name + full
      // child labels.
      let label = b.label;
      let items = b.items;
      if (!label) {
        const suffix = b.items[0].label.includes(": ") ? b.items[0].label.slice(b.items[0].label.indexOf(": ") + 2) : null;
        if (suffix && b.items.every((it) => it.label.endsWith(`: ${suffix}`) || it.label === suffix)) {
          label = suffix;
          items = b.items.map((it) => ({ ...it, label: it.label === suffix ? it.label : it.label.slice(0, it.label.length - suffix.length - 2) }));
        } else {
          label = b.items[0].label;
        }
      }
      return { key, label, items, grouped: true };
    });
  }, [expenseItems, accounts]);

  // Federal tax breakdown -- shown as negative (a deduction), same sign convention as the summary row above it.
  const federalTaxComponentMaps = useMemo(
    () => periods.map((y) => new Map(y.cashFlow.federalTaxByComponent.map((c) => [c.key, -c.amount]))),
    [periods]
  );
  const federalTaxComponentItems = useMemo(() => {
    const labels = new Map<string, string>();
    for (const y of periods) for (const c of y.cashFlow.federalTaxByComponent) labels.set(c.key, c.label);
    return FEDERAL_TAX_COMPONENT_ORDER.filter((k) => labels.has(k)).map((k) => ({ id: k, label: `${labels.get(k)} (actual)` }));
  }, [periods]);

  // Withdrawal source accounts, grouped by tax treatment (only groups with data).
  const withdrawalGroups = useMemo(() => {
    const items = unionWithdrawals(periods.map((y) => y.cashFlow.withdrawalsByAccount));
    return TAX_GROUPS.map((g) => ({ ...g, accounts: items.filter((it) => it.taxTreatment === g.key) })).filter(
      (g) => g.accounts.length > 0
    );
  }, [periods]);

  // Estimated withholding taken at the source from taxable/tax-deferred
  // withdrawals -- shown as an informational drill-down under Federal Tax,
  // alongside the benefit withholding and true-up (it's already netted out
  // of the gross withdrawal amounts shown in Account Activity above).
  const withholdingItems = useMemo(() => {
    const items: { id: string; label: string }[] = [];
    for (const g of withdrawalGroups) for (const a of g.accounts) items.push({ id: a.id, label: a.label });
    return items.filter((it) => periods.some((_p, yi) => (wdTaxMaps[yi].get(it.id) ?? 0) > 0.5));
  }, [withdrawalGroups, periods, wdTaxMaps]);

  // Account name lookup for the unified Account Activity section below.
  const accountNameById = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const depositOf = (accountId: string, yi: number) =>
    (contribMaps[yi].get(`${accountId}:contribution`) ?? 0) + (surplusMaps[yi].get(accountId) ?? 0);
  const withdrawnOf = (accountId: string, yi: number) => wdGrossMaps[yi].get(accountId) ?? 0;
  // otherActivityByItem is signed by its effect on CASH (positive = cash
  // increased), the opposite of this section's account-centric convention
  // (positive = the account gained), so it's negated everywhere it's folded
  // in below.
  const otherOf = (accountId: string, yi: number) => otherActivityMapsByAccount[yi].get(accountId) ?? 0;
  // Net movement for the account, EXCLUDING payroll-deducted contributions --
  // those never touched cash (take-home pay was already entered net of
  // them), so folding them in would make the net look like a bigger save
  // than actually happened. Matches how the old "Saved to accounts" total
  // was computed (afterTaxContributionTotal, not all contributions).
  const netOf = (accountId: string, fromPaycheck: boolean, yi: number) => {
    const contrib = fromPaycheck ? 0 : (contribMaps[yi].get(`${accountId}:contribution`) ?? 0);
    const surplus = surplusMaps[yi].get(accountId) ?? 0;
    return contrib + surplus - withdrawnOf(accountId, yi) - otherOf(accountId, yi);
  };

  // Every account with a withdrawal, contribution, swept surplus, or other
  // direct activity in the visible range, merged into one entry so an
  // account's savings and withdrawals for the year sit together instead of
  // in separate sections.
  const activityAccounts = useMemo(() => {
    const ids = new Set<string>();
    for (const m of wdGrossMaps) for (const id of m.keys()) ids.add(id);
    for (const m of surplusMaps) for (const id of m.keys()) ids.add(id);
    for (const m of contribMaps) for (const key of m.keys()) ids.add(key.replace(/:contribution$/, ""));
    for (const m of otherActivityMapsByAccount) for (const id of m.keys()) ids.add(id);
    const fromPaycheckOf = new Map(contribItems.map((it) => [it.id.replace(/:contribution$/, ""), it.fromPaycheck]));
    const magnitude = (id: string) =>
      periods.reduce(
        (s, _y, yi) =>
          s +
          (wdGrossMaps[yi].get(id) ?? 0) +
          (contribMaps[yi].get(`${id}:contribution`) ?? 0) +
          (surplusMaps[yi].get(id) ?? 0) +
          Math.abs(otherActivityMapsByAccount[yi].get(id) ?? 0),
        0
      );
    return [...ids]
      .map((id) => ({
        id,
        label: id === "__other__" ? "Other" : accountNameById.get(id) ?? id,
        fromPaycheck: fromPaycheckOf.get(id) ?? false,
      }))
      .sort((a, b) => magnitude(b.id) - magnitude(a.id));
  }, [wdGrossMaps, surplusMaps, contribMaps, otherActivityMapsByAccount, contribItems, accountNameById, periods]);

  const totalNet = (yi: number) => activityAccounts.reduce((s, a) => s + netOf(a.id, a.fromPaycheck, yi), 0);

  const hasCashInterest = periods.some((y) => Math.abs(y.cashFlow.cashInterest) > 0.5);
  const hasBenefitWithholding = periods.some((y) => Math.abs(y.cashFlow.incomeTaxWithheldFromCash) > 0.5);
  const hasSettlement = periods.some((y) => Math.abs(y.cashFlow.taxSettlement) > 0.5);
  const hasFederalTax = periods.some((y) => y.cashFlow.federalTaxTotal > 0.5);
  const hasWithdrawalWithholding = withholdingItems.length > 0;

  if (periods.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel p-8 text-center text-sm text-dim">
        No {isMonthly ? "months" : "years"}{" "}
        in the selected range.
      </div>
    );
  }

  const col = periods.length + 2; // label + each visible year + total

  // Sum of a row's deflated per-year values across the selected range.
  const totalOf = (get: (yi: number) => number) => periods.reduce((s, _y, yi) => s + d(get(yi), yi), 0);

  const totalCellClass = "py-2 pr-3 text-right tabular-nums bg-background/40 font-medium";

  // Column highlight: hovering any cell in a year's column highlights that
  // whole column, including its header -- tracked here since it has to reach
  // cells across many different rows built by several helpers below.
  const colHoverProps = (yi: number) => ({
    onMouseEnter: () => setHoveredCol(yi),
    onMouseLeave: () => setHoveredCol(null),
  });
  const colHoverClass = (yi: number) => (hoveredCol === yi ? "bg-accent/10" : "");

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

  // Money cells across every visible year plus a trailing total, deflated as
  // needed. `signed` colors negative/positive values (for rows like a net
  // that can go either way) instead of showing plain unsigned text.
  const cells = (get: (yi: number) => number, opts?: { signed?: boolean }) => (
    <>
      {periods.map((p, yi) => {
        const v = d(get(yi), yi);
        return (
          <td key={p.periodKey} className={`py-2 pr-3 text-right tabular-nums ${colHoverClass(yi)}`} {...colHoverProps(yi)}>
            {Math.abs(v) < 0.5 ? (
              <span className="text-dim">—</span>
            ) : opts?.signed ? (
              <span className={v < 0 ? "text-negative" : "text-positive"}>{formatMoney(v)}</span>
            ) : (
              formatMoney(v)
            )}
          </td>
        );
      })}
      {totalCell(totalOf(get), { signed: opts?.signed })}
    </>
  );

  const summaryRow = (
    label: string,
    get: (yi: number) => number,
    opts?: { totalIsMeaningful?: boolean; strong?: boolean; hint?: string; balance?: boolean }
  ) => (
    <tr className={`border-t hover:bg-accent/15 ${opts?.strong ? "border-dim/25" : "border-border"}`}>
      <td className="py-2.5 pl-2 font-bold">
        <span className="inline-flex items-center gap-1">
          {label}
          {opts?.hint && <InfoTooltip text={opts.hint} />}
        </span>
      </td>
      {periods.map((p, yi) => {
        const v = opts?.balance ? dBalance(get(yi), yi) : d(get(yi), yi);
        return (
          <td key={p.periodKey} className={`py-2 pr-3 text-right font-semibold tabular-nums ${colHoverClass(yi)}`} {...colHoverProps(yi)}>
            <span className={v < 0 ? "text-negative" : v > 0 ? "text-positive" : "text-dim"}>{formatMoney(v)}</span>
          </td>
        );
      })}
      {opts?.totalIsMeaningful === false ? (
        <td className={totalCellClass}>
          <span className="text-dim" title="A point-in-time balance isn't meaningful to sum across periods">
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
    <tr className="border-t border-border/40 text-dim hover:bg-accent/15">
      <td className="py-2 pl-2">
        <span className="inline-flex items-center gap-1">
          {label}
          {hint && <InfoTooltip text={hint} />}
        </span>
      </td>
      {periods.map((p, yi) => {
        const v = d(get(yi), yi);
        return (
          <td key={p.periodKey} className={`py-2 pr-3 text-right tabular-nums ${colHoverClass(yi)}`} {...colHoverProps(yi)}>
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

  const sectionHeader = (key: string, label: string, get: (yi: number) => number, hint?: string, opts?: { signed?: boolean }) => (
    <tr className="cursor-pointer border-t border-dim/25 hover:bg-accent/15" onClick={() => toggle(key)}>
      <td className="py-2.5 pl-2 font-semibold">
        <span className="inline-flex items-center gap-1">
          <ToggleLabel label={label} expanded={isOpen(key)} onToggle={() => toggle(key)} />
          {hint && <InfoTooltip text={hint} />}
        </span>
      </td>
      {cells(get, opts)}
    </tr>
  );

  const itemRows = (items: { id: string; label: string }[], maps: Map<string, number>[], indent = "pl-10") =>
    items.map((item) => (
      <tr key={item.id} className="border-t border-border/40 text-dim hover:bg-accent/15">
        <td className={`py-2 ${indent}`}>{item.label}</td>
        {cells((yi) => maps[yi].get(item.id) ?? 0)}
      </tr>
    ));

  // Blank row dropped between major sections so they read as visually
  // separated groups. Filled with the page background (not the table's own
  // panel color) so the gap actually reads as a gap, and its top edge
  // doubles as the lighter border that caps off the section above.
  const spacerRow = (key: string) => (
    <tr key={key} aria-hidden="true">
      <td className="h-3 border-y border-dim/25 !bg-background p-0" colSpan={col} />
    </tr>
  );

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
        <table className="w-full border-separate border-spacing-0 text-sm tabular-nums [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:border-b [&_thead_th]:border-border [&_thead_th]:bg-panel-2 [&_thead_th:not(:first-child)]:z-20 [&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10 [&_tbody_td:first-child]:bg-panel [&_tbody_tr:hover>td:first-child]:!bg-[color-mix(in_srgb,var(--panel)_85%,var(--accent)_15%)] [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
          <thead>
            <tr className="text-left text-xs text-dim">
              <th className="sticky left-0 top-0 z-30 border-b border-border bg-panel-2 py-2.5 pl-2 font-medium">Category</th>
              {periods.map((p, yi) => (
                <th
                  key={p.periodKey}
                  className={`py-2.5 pr-3 text-right font-medium ${colHoverClass(yi)}`}
                  {...colHoverProps(yi)}
                >
                  {p.periodLabel}
                </th>
              ))}
              <th className="bg-background/40 py-2.5 pr-3 text-right font-medium">
                Total ({periods[0].periodLabel}–{periods[periods.length - 1].periodLabel})
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Income */}
            {sectionHeader("income", "Income", (yi) => periods[yi].cashFlow.totalIncome)}
            {isOpen("income") && (incomeItems.length ? itemRows(incomeItems, incomeMaps) : emptyRow("No income in this range."))}

            {/* Expenses -- grouped by life event / home, expandable to the
                underlying one-time + recurring pieces. */}
            {spacerRow("spacer:expenses")}
            {sectionHeader("expenses", "Expenses", (yi) => periods[yi].cashFlow.totalExpenses)}
            {isOpen("expenses") &&
              (expenseGroups.length
                ? expenseGroups.map((g) =>
                    g.grouped ? (
                      <Fragment key={g.key}>
                        <tr className="cursor-pointer border-t border-border/40 hover:bg-accent/15" onClick={() => toggle(`exp:${g.key}`)}>
                          <td className="py-2 pl-6 font-medium">
                            <ToggleLabel
                              label={g.label}
                              expanded={isOpen(`exp:${g.key}`)}
                              onToggle={() => toggle(`exp:${g.key}`)}
                            />
                          </td>
                          {cells((yi) => g.items.reduce((s, it) => s + (expenseMaps[yi].get(it.id) ?? 0), 0))}
                        </tr>
                        {isOpen(`exp:${g.key}`) && itemRows(g.items, expenseMaps, "pl-12")}
                      </Fragment>
                    ) : (
                      <tr key={g.key} className="border-t border-border/40 text-dim hover:bg-accent/15">
                        <td className="py-2 pl-10">{g.label}</td>
                        {cells((yi) => expenseMaps[yi].get(g.items[0].id) ?? 0)}
                      </tr>
                    )
                  )
                : emptyRow("No expenses in this range."))}

            {/* Operating surplus / (shortfall) */}
            {spacerRow("spacer:operatingSurplus")}
            {summaryRow("Operating surplus / (shortfall)", (yi) => periods[yi].cashFlow.operatingCashFlow, {
              strong: true,
              hint: "Income minus expenses. When it goes negative (typically once income drops in retirement), Withdrawals below pull from your accounts to cover it.",
            })}

            {/* Account Activity -- every account with a deposit, swept
                surplus, withdrawal, or other direct flow this year, merged
                into one entry so the different sides of the same account sit
                together instead of in separate sections. Each account row is
                collapsed by default; click to reveal its detail lines. Net
                excludes payroll-deducted contributions (they never touched
                cash). Withdrawals are shown GROSS (including tax withheld at
                the source); expand one to split it into estimated
                withholding and the net amount that actually reached cash. */}
            {spacerRow("spacer:accountActivity")}
            {sectionHeader(
              "accountActivity",
              "Account Activity",
              totalNet,
              "Net movement for each account this year: what was deposited or swept in as surplus, minus what was withdrawn (including tax withheld at the source, for RMDs and planned drawdowns) and minus other direct flows like a down payment or home sale. Excludes payroll-deducted contributions from the net, since those never touched cash -- take-home pay was already entered net of them. Click an account to see the detail.",
              { signed: true }
            )}
            {isOpen("accountActivity") &&
              (activityAccounts.length
                ? activityAccounts.map((a) => {
                    const hasTax = periods.some((_p, yi) => (wdTaxMaps[yi].get(a.id) ?? 0) > 0.5);
                    const hasDeposit = periods.some((_p, yi) => depositOf(a.id, yi) > 0.5);
                    const hasWithdrawal = periods.some((_p, yi) => withdrawnOf(a.id, yi) > 0.5);
                    const hasOther = periods.some((_p, yi) => Math.abs(otherOf(a.id, yi)) > 0.5);
                    const acctKey = `aa:${a.id}`;
                    return (
                      <Fragment key={a.id}>
                        <tr className="cursor-pointer border-t border-border/40 hover:bg-accent/15" onClick={() => toggle(acctKey)}>
                          <td className="py-2 pl-6 font-medium">
                            <ToggleLabel label={a.label} expanded={isOpen(acctKey)} onToggle={() => toggle(acctKey)} />
                          </td>
                          {cells((yi) => netOf(a.id, a.fromPaycheck, yi), { signed: true })}
                        </tr>
                        {isOpen(acctKey) && (
                          <>
                            {hasDeposit && (
                              <tr className="text-dim hover:bg-accent/15">
                                <td className="py-2 pl-12">
                                  Deposited / saved
                                  {a.fromPaycheck && <span className="ml-2 text-xs italic">from paycheck, excluded from net</span>}
                                </td>
                                {cells((yi) => depositOf(a.id, yi))}
                              </tr>
                            )}
                            {hasWithdrawal && (
                              <>
                                <tr
                                  className={`text-dim hover:bg-accent/15 ${hasTax ? "cursor-pointer" : ""}`}
                                  onClick={hasTax ? () => toggle(`wd:acct:${a.id}`) : undefined}
                                >
                                  <td className="py-2 pl-12">
                                    {hasTax ? (
                                      <ToggleLabel label="Withdrawn" expanded={isOpen(`wd:acct:${a.id}`)} onToggle={() => toggle(`wd:acct:${a.id}`)} />
                                    ) : (
                                      "Withdrawn"
                                    )}
                                  </td>
                                  {cells((yi) => withdrawnOf(a.id, yi))}
                                </tr>
                                {hasTax && isOpen(`wd:acct:${a.id}`) && (
                                  <>
                                    <tr className="border-t border-border/40 text-dim hover:bg-accent/15">
                                      <td className="py-2 pl-[4.5rem] text-xs italic">Estimated withholding</td>
                                      {cells((yi) => wdTaxMaps[yi].get(a.id) ?? 0)}
                                    </tr>
                                    <tr className="border-t border-border/40 text-dim hover:bg-accent/15">
                                      <td className="py-2 pl-[4.5rem] text-xs italic">Net withdrawal</td>
                                      {cells((yi) => (wdGrossMaps[yi].get(a.id) ?? 0) - (wdTaxMaps[yi].get(a.id) ?? 0))}
                                    </tr>
                                  </>
                                )}
                              </>
                            )}
                            {hasOther && (
                              <tr className="text-dim hover:bg-accent/15">
                                <td className="py-2 pl-12">Other activity</td>
                                {cells((yi) => -otherOf(a.id, yi), { signed: true })}
                              </tr>
                            )}
                          </>
                        )}
                      </Fragment>
                    );
                  })
                : emptyRow("No account activity in this range."))}

            {/* Cash-side tax rows -- withholding on benefit deposits and the
                December true-up -- are shown under Federal Tax below, not
                here, so all tax estimates/actuals/true-up live in one place.
                They still count toward Net change in cash below; that row is
                measured from the actual simulated balance, not summed. */}

            {/* Interest earned directly on cash -- the one remaining flow
                that isn't tied to any account, shown whenever present so the
                visible rows always sum exactly to the bottom line. */}
            {hasCashInterest && (
              <tr className="border-t border-border/40 text-dim hover:bg-accent/15">
                <td className="py-2 pl-2">Interest earned on cash</td>
                {cells((yi) => periods[yi].cashFlow.cashInterest)}
              </tr>
            )}
            {/* Net change in cash -- the reconciling bottom line, measured
                directly from the actual simulated cash balance. Account
                Activity's net is deposits minus GROSS withdrawals (including
                withholding), so to tie out by hand subtract the estimated
                withholdings shown in the Taxes section. */}
            {spacerRow("spacer:netChangeInCash")}
            {summaryRow("Net change in cash", (yi) => periods[yi].cashFlow.netCashFlow, {
              strong: true,
              hint: "The measured change in Extra Savings' balance this year. To tie out by hand: operating result - Account Activity (net) - estimated withholdings + true-up + interest + other activity. Lands near $0 in a year where you draw just what you need.",
            })}
            {summaryRow("Ending cash on hand", (yi) => periods[yi].cashFlow.endingCashBalance, {
              totalIsMeaningful: false,
              balance: true,
              hint: "Your total balance across all cash accounts, not just Extra Savings -- a broader figure than the reconciliation above. Not summed in the Total column since it's a balance, not a flow.",
            })}

            {/* Federal tax -- informational: everything from withholding
                estimates through the exact bracket-computed bill to the
                year-end true-up lives here together. Thanks to the true-up
                row, "Federal tax (actual bill)" IS the cash tax the household
                actually paid for the year; the section as a whole is shown
                separately from the reconciliation above because most of it
                was withheld at the source accounts, not from cash. */}
            {(hasFederalTax || hasBenefitWithholding || hasWithdrawalWithholding || hasSettlement) && (
              <>
                {spacerRow("spacer:taxes")}
                <tr className="cursor-pointer border-t border-dim/25 hover:bg-accent/15" onClick={() => toggle("taxes")}>
                  <td className="py-2.5 pl-2 font-bold">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-dim">
                      <ToggleLabel label="Taxes (informational)" expanded={isOpen("taxes")} onToggle={() => toggle("taxes")} />
                      <InfoTooltip
                        text={
                          "Not part of the cash reconciliation above -- most tax is withheld inside the source accounts (it shows up in each account's gross withdrawal), with the year-end true-up settling the difference into cash." +
                          (isMonthly
                            ? " In a monthly view, withholding appears in the month it's taken, but the actual bill and the true-up are only knowable once the whole year's income is in -- so both land entirely on December."
                            : "")
                        }
                      />
                    </span>
                  </td>
                  {col > 1 && <td colSpan={col - 1} />}
                </tr>
                {isOpen("taxes") && (
                  <>
                    {/* 1. The actual bracket-computed bill, by income component. */}
                    <tr className="cursor-pointer border-t border-border hover:bg-accent/15" onClick={() => toggle("federalTax")}>
                      <td className="py-2.5 pl-2 font-bold">
                        <span className="inline-flex items-center gap-1">
                          <ToggleLabel label="Federal tax (actual bill)" expanded={isOpen("federalTax")} onToggle={() => toggle("federalTax")} />
                          <InfoTooltip text="The exact bill for the year from real IRS brackets on actual realized income -- and, after the year-end true-up, exactly what the household actually paid. Expand to see which income sources it came from. Tax is computed on the household's joint income, so it can't be split per person." />
                        </span>
                      </td>
                      {periods.map((p, yi) => {
                        const v = d(-periods[yi].cashFlow.federalTaxTotal, yi);
                        return (
                          <td key={p.periodKey} className={`py-2 pr-3 text-right font-semibold tabular-nums ${colHoverClass(yi)}`} {...colHoverProps(yi)}>
                            <span className={v < 0 ? "text-negative" : v > 0 ? "text-positive" : "text-dim"}>{formatMoney(v)}</span>
                          </td>
                        );
                      })}
                      {totalCell(totalOf((yi) => -periods[yi].cashFlow.federalTaxTotal), { signed: true })}
                    </tr>
                    {isOpen("federalTax") &&
                      (federalTaxComponentItems.length
                        ? itemRows(federalTaxComponentItems, federalTaxComponentMaps)
                        : emptyRow("No federal tax in this range."))}

                    {/* 2. Everything withheld during the year: per-account
                        withholding on withdrawals + withholding on benefit
                        deposits. */}
                    {(hasWithdrawalWithholding || hasBenefitWithholding) && (
                      <>
                        {sectionHeader(
                          "withholdings",
                          "Estimated withholdings (total withheld)",
                          (yi) =>
                            -withholdingItems.reduce((s, it) => s + (wdTaxMaps[yi].get(it.id) ?? 0), 0) -
                            periods[yi].cashFlow.incomeTaxWithheldFromCash,
                          "All estimated tax withheld during the year: at the source on account withdrawals, and from Social Security / pension deposits before they reach cash. Expand to see it by source."
                        )}
                        {isOpen("withholdings") && (
                          <>
                            {itemRows(
                              withholdingItems.map((it) => ({ ...it, label: `${it.label} est. withholding` })),
                              periods.map((_p, yi) => new Map(withholdingItems.map((it) => [it.id, -(wdTaxMaps[yi].get(it.id) ?? 0)])))
                            )}
                            {hasBenefitWithholding &&
                              itemRows(
                                [{ id: "benefits", label: "Social Security / pension est. withholding" }],
                                periods.map((_p, yi) => new Map([["benefits", -periods[yi].cashFlow.incomeTaxWithheldFromCash]]))
                              )}
                          </>
                        )}
                      </>
                    )}

                    {/* 3. December settlement of withheld vs. actual. */}
                    {hasSettlement &&
                      reconcileRow(
                        "Tax true-up (year-end settlement)",
                        (yi) => periods[yi].cashFlow.taxSettlement,
                        "Each December the estimated withholding is settled against the exact bracket-computed bill -- positive is a refund back into cash, negative is extra tax owed. After this, the year's total withheld plus this settlement equals the Federal tax (actual bill) line above exactly."
                      )}
                  </>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
