"use client";

import { Fragment, useState } from "react";
import type { Account, Id, Person, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { accountClassLabels, ASSET_CLASS_ORDER, LIABILITY_CLASS_ORDER } from "@/lib/labels";
import { AccountDrawer } from "@/components/accounts/AccountDrawer";

/** Deflate a nominal dollar amount to today's dollars when in real mode. */
function deflate(value: number, year: YearSnapshot, mode: DollarMode): number {
  return mode === "real" ? value / year.inflationDeflator : value;
}

function balanceOf(year: YearSnapshot, accountId: Id): number {
  return year.accountBalances[accountId] ?? 0;
}

function RollforwardRows({ accountId, years, mode }: { accountId: Id; years: YearSnapshot[]; mode: DollarMode }) {
  const fields: { label: string; get: (y: YearSnapshot) => number }[] = [
    { label: "Starting balance", get: (y) => y.rollforwards.find((r) => r.accountId === accountId)?.startingBalance ?? 0 },
    { label: "Inflation adjustment", get: (y) => y.rollforwards.find((r) => r.accountId === accountId)?.inflationAdjustment ?? 0 },
    { label: "Growth", get: (y) => y.rollforwards.find((r) => r.accountId === accountId)?.growth ?? 0 },
    { label: "Deposits", get: (y) => y.rollforwards.find((r) => r.accountId === accountId)?.deposits ?? 0 },
    { label: "Withdrawals", get: (y) => -(y.rollforwards.find((r) => r.accountId === accountId)?.withdrawals ?? 0) },
    { label: "Ending balance", get: (y) => y.rollforwards.find((r) => r.accountId === accountId)?.endingBalance ?? 0 },
  ];
  return (
    <>
      {fields.map((f) => (
        <tr key={f.label} className="bg-background/30 text-xs text-dim">
          <td className="py-1 pl-14">{f.label}</td>
          {years.map((y) => (
            <td key={y.year} className="py-1 pr-2 text-right">
              {formatMoney(deflate(f.get(y), y, mode))}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function AccountRow({
  account,
  years,
  editable,
  onEdit,
  mode,
}: {
  account: Account;
  years: YearSnapshot[];
  editable: boolean;
  onEdit: () => void;
  mode: DollarMode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="hover:bg-background/40">
        <td className="cursor-pointer py-1.5 pl-10" onClick={() => setExpanded((v) => !v)}>
          <span className="mr-1 inline-block w-3 text-dim">{expanded ? "▾" : "▸"}</span>
          {account.name}
          {account.isExcluded && <span className="ml-2 text-xs text-dim">(excluded)</span>}
          {account.balanceUpdateRequired && (
            <span className="ml-2 text-xs text-negative">Balance update required</span>
          )}
          {editable && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="ml-2 text-dim hover:text-accent"
              title="Edit account"
            >
              ✎
            </button>
          )}
        </td>
        {years.map((y) => (
          <td key={y.year} className="py-1.5 pr-2 text-right" onClick={() => setExpanded((v) => !v)}>
            {formatMoney(deflate(balanceOf(y, account.id), y, mode))}
          </td>
        ))}
      </tr>
      {expanded && <RollforwardRows accountId={account.id} years={years} mode={mode} />}
    </>
  );
}

function Section({
  title,
  accounts,
  years,
  classes,
  editableIds,
  onEdit,
  mode,
}: {
  title: string;
  accounts: Account[];
  years: YearSnapshot[];
  classes: string[];
  editableIds: Set<Id>;
  onEdit: (account: Account) => void;
  mode: DollarMode;
}) {
  const groups = classes
    .map((cls) => ({ cls, accounts: accounts.filter((a) => a.class === cls) }))
    .filter((g) => g.accounts.length > 0);

  const sectionTotal = (year: YearSnapshot) =>
    groups.reduce((sum, g) => sum + g.accounts.reduce((s, a) => s + balanceOf(year, a.id), 0), 0);

  return (
    <>
      <tr className="border-t border-border bg-background/40">
        <td className="py-2 pl-2 font-semibold">{title}</td>
        {years.map((y) => (
          <td key={y.year} className="py-2 pr-2 text-right font-semibold">
            {formatMoney(deflate(sectionTotal(y), y, mode))}
          </td>
        ))}
      </tr>
      {groups.map((g) => (
        <Fragment key={g.cls}>
          <tr className="text-dim">
            <td className="py-1.5 pl-6">{accountClassLabels[g.cls as keyof typeof accountClassLabels]}</td>
            {years.map((y) => (
              <td key={y.year} className="py-1.5 pr-2 text-right">
                {formatMoney(deflate(g.accounts.reduce((s, a) => s + balanceOf(y, a.id), 0), y, mode))}
              </td>
            ))}
          </tr>
          {g.accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              years={years}
              editable={editableIds.has(a.id)}
              onEdit={() => onEdit(a)}
              mode={mode}
            />
          ))}
        </Fragment>
      ))}
    </>
  );
}

export function AccountsTable({
  accounts,
  years,
  editableAccountIds,
  people,
  dollarMode,
}: {
  accounts: Account[];
  years: YearSnapshot[];
  editableAccountIds: Set<Id>;
  people: Person[];
  dollarMode: DollarMode;
}) {
  const [drawerAccount, setDrawerAccount] = useState<Account | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (years.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel p-8 text-center text-sm text-dim">
        No years in the selected range.
      </div>
    );
  }

  const netWorthOf = (y: YearSnapshot) => (dollarMode === "real" ? y.netWorthReal : y.netWorthNominal);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setDrawerAccount(undefined);
            setDrawerOpen(true);
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
        >
          + Add Account
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-sm [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:border-b [&_thead_th]:border-border [&_thead_th]:bg-panel [&_thead_th:not(:first-child)]:z-20 [&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10 [&_tbody_td:first-child]:border-r [&_tbody_td:first-child]:border-border [&_tbody_td:first-child]:bg-panel">
          <thead>
            <tr className="text-left text-xs text-dim">
              <th className="sticky left-0 top-0 z-30 border-b border-r border-border bg-panel py-2 pl-2 font-medium">Account</th>
              {years.map((y) => (
                <th key={y.year} className="py-2 pr-2 text-right font-medium">
                  {y.year}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-2 pl-2 font-bold">Net Worth</td>
              {years.map((y) => (
                <td key={y.year} className="py-2 pr-2 text-right font-bold">
                  {formatMoney(netWorthOf(y))}
                </td>
              ))}
            </tr>
            <Section
              title="Assets"
              accounts={accounts.filter((a) => a.category === "asset")}
              years={years}
              classes={ASSET_CLASS_ORDER}
              editableIds={editableAccountIds}
              onEdit={(a) => {
                setDrawerAccount(a);
                setDrawerOpen(true);
              }}
              mode={dollarMode}
            />
            <Section
              title="Liabilities"
              accounts={accounts.filter((a) => a.category === "liability")}
              years={years}
              classes={LIABILITY_CLASS_ORDER}
              editableIds={editableAccountIds}
              onEdit={(a) => {
                setDrawerAccount(a);
                setDrawerOpen(true);
              }}
              mode={dollarMode}
            />
          </tbody>
        </table>
        </div>
        <p className="border-t border-border px-2 py-2 text-xs text-dim">
          Click an account to see its year-by-year rollforward. Accounts created by an event (e.g. a
          home purchase) are edited via that event, not here.
        </p>
      </div>
      <AccountDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} account={drawerAccount} people={people} />
    </div>
  );
}
