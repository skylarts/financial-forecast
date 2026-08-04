"use client";

import { createContext, Fragment, useContext, useState } from "react";
import type { Account, BuyHomeEvent, Granularity, Id, PeriodSnapshot, Person, ScenarioEvent } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { ASSET_CLASS_GROUPS, LIABILITY_CLASS_GROUPS, type AccountClassGroup } from "@/lib/labels";
import { AccountDrawer } from "@/components/accounts/AccountDrawer";
import { HomeDrawer } from "@/components/accounts/HomeDrawer";
import { useUiStore } from "@/store/useUiStore";

/** Deflate a nominal dollar amount to today's dollars when in real mode. */
function deflate(value: number, period: PeriodSnapshot, mode: DollarMode): number {
  return mode === "real" ? value / period.inflationDeflator : value;
}

function balanceOf(period: PeriodSnapshot, accountId: Id): number {
  return period.accountBalances[accountId] ?? 0;
}

// Tracks which year-column is currently hovered so the whole column (its
// header included) can be highlighted alongside the row the mouse is over --
// row highlighting itself is plain CSS (:hover on the <tr>), but a column
// highlight has to span cells in many different rows, so it needs shared
// state instead.
const ColHoverContext = createContext<{ col: number | null; setCol: (c: number | null) => void }>({
  col: null,
  setCol: () => {},
});

function colHoverProps(index: number, col: number | null, setCol: (c: number | null) => void) {
  return {
    onMouseEnter: () => setCol(index),
    onMouseLeave: () => setCol(null),
    className: col === index ? "bg-accent/10" : "",
  };
}

function RollforwardRows({ accountId, periods, mode }: { accountId: Id; periods: PeriodSnapshot[]; mode: DollarMode }) {
  const { col, setCol } = useContext(ColHoverContext);
  const fields: { label: string; get: (p: PeriodSnapshot) => number; strong?: boolean }[] = [
    { label: "Starting balance", get: (p) => p.rollforwards.find((r) => r.accountId === accountId)?.startingBalance ?? 0 },
    { label: "Inflation adjustment", get: (p) => p.rollforwards.find((r) => r.accountId === accountId)?.inflationAdjustment ?? 0 },
    { label: "Growth", get: (p) => p.rollforwards.find((r) => r.accountId === accountId)?.growth ?? 0 },
    { label: "Deposits", get: (p) => p.rollforwards.find((r) => r.accountId === accountId)?.deposits ?? 0 },
    { label: "Withdrawals", get: (p) => -(p.rollforwards.find((r) => r.accountId === accountId)?.withdrawals ?? 0) },
    {
      label: "Net deposits / withdrawals",
      strong: true,
      get: (p) => {
        const r = p.rollforwards.find((r) => r.accountId === accountId);
        return (r?.deposits ?? 0) - (r?.withdrawals ?? 0);
      },
    },
    { label: "Ending balance", get: (p) => p.rollforwards.find((r) => r.accountId === accountId)?.endingBalance ?? 0 },
  ];
  return (
    <>
      {fields.map((f) => (
        <tr key={f.label} className={`border-t border-border/40 text-xs hover:bg-accent/15 ${f.strong ? "text-foreground font-medium" : "text-dim"}`}>
          <td className="py-2.5 pl-14">{f.label}</td>
          {periods.map((p, i) => {
            const hover = colHoverProps(i, col, setCol);
            const v = deflate(f.get(p), p, mode);
            return (
              <td key={p.periodKey} className={`py-2.5 pr-4 text-right ${hover.className}`} onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave}>
                {f.strong ? (
                  <span className={v < 0 ? "text-negative" : v > 0 ? "text-positive" : ""}>{formatMoney(v)}</span>
                ) : (
                  formatMoney(v)
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
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

function AccountRow({
  account,
  periods,
  editable,
  onEdit,
  mode,
}: {
  account: Account;
  periods: PeriodSnapshot[];
  editable: boolean;
  onEdit: () => void;
  mode: DollarMode;
}) {
  const rowKey = `row:${account.id}`;
  const expanded = useUiStore((s) => s.accountsExpanded.includes(rowKey));
  const toggleExpanded = useUiStore((s) => s.toggleAccountsExpanded);
  const { col, setCol } = useContext(ColHoverContext);
  return (
    <>
      <tr className="cursor-pointer border-t border-border/40 hover:bg-accent/15" onClick={() => toggleExpanded(rowKey)}>
        <td className="py-3 pl-10">
          <span className="mr-1 inline-block w-3 text-dim">{expanded ? "▾" : "▸"}</span>
          {account.name}
          {account.isExtraSavings && (
            <span className="ml-2 text-xs text-dim" title="The spending hub: income lands here, expenses pay from here, and each month's surplus is swept out to your split targets -- so a $0 balance is normal and healthy.">
              (spending hub)
            </span>
          )}
          {account.isExcluded && <span className="ml-2 text-xs text-dim">(excluded)</span>}
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
        {periods.map((p, i) => {
          const hover = colHoverProps(i, col, setCol);
          return (
            <td key={p.periodKey} className={`py-3 pr-4 text-right ${hover.className}`} onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave}>
              {formatMoney(deflate(balanceOf(p, account.id), p, mode))}
            </td>
          );
        })}
      </tr>
      {expanded && <RollforwardRows accountId={account.id} periods={periods} mode={mode} />}
    </>
  );
}

function Section({
  title,
  accounts,
  periods,
  groups: groupDefs,
  editableIds,
  onEdit,
  mode,
}: {
  title: string;
  accounts: Account[];
  periods: PeriodSnapshot[];
  groups: AccountClassGroup[];
  editableIds: Set<Id>;
  onEdit: (account: Account) => void;
  mode: DollarMode;
}) {
  const sectionKey = `section:${title}`;
  const sectionOpen = useUiStore((s) => s.accountsExpanded.includes(sectionKey));
  const accountsExpanded = useUiStore((s) => s.accountsExpanded);
  const toggleExpanded = useUiStore((s) => s.toggleAccountsExpanded);
  const setSectionOpen = () => toggleExpanded(sectionKey);
  const groupKey = (label: string) => `group:${title}:${label}`;
  const toggleGroup = (label: string) => toggleExpanded(groupKey(label));

  const groups = groupDefs
    .map((g) => ({
      ...g,
      // Extra Savings is the mandatory system account -- always shown last
      // within its class group (Cash) rather than sorted in with the rest.
      accounts: accounts
        .filter((a) => g.classes.includes(a.class))
        .sort((a, b) => Number(!!a.isExtraSavings) - Number(!!b.isExtraSavings)),
    }))
    .filter((g) => g.accounts.length > 0);

  // Excluded accounts are still shown as a row (see AccountRow's badge) but
  // never counted toward a subtotal -- that's the whole point of exclusion.
  const includedBalance = (period: PeriodSnapshot, accts: Account[]) =>
    accts.reduce((s, a) => (a.isExcluded ? s : s + balanceOf(period, a.id)), 0);

  const sectionTotal = (period: PeriodSnapshot) =>
    groups.reduce((sum, g) => sum + includedBalance(period, g.accounts), 0);

  const { col, setCol } = useContext(ColHoverContext);

  return (
    <>
      <tr className="cursor-pointer border-t border-dim/25 hover:bg-accent/15" onClick={setSectionOpen}>
        <td className="py-3.5 pl-2 font-semibold">
          <ToggleLabel label={title} expanded={sectionOpen} onToggle={setSectionOpen} />
        </td>
        {periods.map((p, i) => {
          const hover = colHoverProps(i, col, setCol);
          return (
            <td key={p.periodKey} className={`py-3.5 pr-4 text-right font-semibold ${hover.className}`} onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave}>
              {formatMoney(deflate(sectionTotal(p), p, mode))}
            </td>
          );
        })}
      </tr>
      {sectionOpen &&
        groups.map((g) => {
          const groupOpen = accountsExpanded.includes(groupKey(g.label));
          return (
            <Fragment key={g.label}>
              <tr className="cursor-pointer border-t border-border/40 text-dim hover:bg-accent/15" onClick={() => toggleGroup(g.label)}>
                <td className="py-3 pl-6">
                  <ToggleLabel label={g.label} expanded={groupOpen} onToggle={() => toggleGroup(g.label)} />
                </td>
                {periods.map((p, i) => {
                  const hover = colHoverProps(i, col, setCol);
                  return (
                    <td key={p.periodKey} className={`py-3 pr-4 text-right ${hover.className}`} onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave}>
                      {formatMoney(deflate(includedBalance(p, g.accounts), p, mode))}
                    </td>
                  );
                })}
              </tr>
              {groupOpen &&
                g.accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    periods={periods}
                    editable={editableIds.has(a.id)}
                    onEdit={() => onEdit(a)}
                    mode={mode}
                  />
                ))}
            </Fragment>
          );
        })}
    </>
  );
}

export function AccountsTable({
  accounts,
  periods,
  editableAccountIds,
  people,
  dollarMode,
  events,
  granularity,
}: {
  accounts: Account[];
  /** One column per period -- calendar years or months, depending on `granularity`. */
  periods: PeriodSnapshot[];
  editableAccountIds: Set<Id>;
  people: Person[];
  dollarMode: DollarMode;
  events: ScenarioEvent[];
  granularity: Granularity;
}) {
  const isMonthly = granularity === "month";
  const [drawerAccount, setDrawerAccount] = useState<Account | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [homeDrawer, setHomeDrawer] = useState<{ open: boolean; account?: Account }>({ open: false });
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  /** A real_estate account edited via the pencil: HomeDrawer itself, along
   *  with its linked buy_home event (if this home was bought rather than
   *  entered as already-owned) so it opens in the right mode. A mortgage
   *  account routes to the same place via its linked real_estate asset --
   *  a mortgage's own terms are edited as part of its home, not standalone.
   *  Returns false (rather than silently doing nothing) if the mortgage
   *  isn't the one its home currently points to -- an orphan left behind by
   *  a stale link, which the caller should open in the plain AccountDrawer
   *  instead so it's still reachable and deletable. */
  const openHomeDrawer = (account: Account): boolean => {
    const homeAccount =
      account.class === "real_estate"
        ? account
        : accounts.find((a) => a.class === "real_estate" && a.linkedLiabilityId === account.id);
    if (!homeAccount) return false;
    setHomeDrawer({ open: true, account: homeAccount });
    return true;
  };
  const homeDrawerEvent: BuyHomeEvent | undefined = homeDrawer.account
    ? (events.find((e) => e.type === "buy_home" && e.realEstateAccountId === homeDrawer.account!.id) as
        | BuyHomeEvent
        | undefined)
    : undefined;

  if (periods.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-panel p-8 text-center text-sm text-dim">
        No {isMonthly ? "months" : "years"}{" "}
        in the selected range.
      </div>
    );
  }

  const netWorthOf = (p: PeriodSnapshot) => (dollarMode === "real" ? p.netWorthReal : p.netWorthNominal);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setDrawerAccount(undefined);
            setDrawerOpen(true);
          }}
          className="rounded-md bg-pri px-3 py-1.5 text-sm font-semibold text-pri-fg"
        >
          + Add Account
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <div className="max-h-[85vh] overflow-auto">
        <ColHoverContext.Provider value={{ col: hoveredCol, setCol: setHoveredCol }}>
        <table className="w-full border-separate border-spacing-0 text-sm tabular-nums [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:border-b [&_thead_th]:border-border [&_thead_th]:bg-panel-2 [&_thead_th:not(:first-child)]:z-20 [&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10 [&_tbody_td:first-child]:bg-panel [&_tbody_tr:hover>td:first-child]:!bg-[color-mix(in_srgb,var(--panel)_85%,var(--accent)_15%)] [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
          <thead>
            <tr className="text-left text-xs text-dim">
              <th className="sticky left-0 top-0 z-30 border-b border-border bg-panel-2 py-3.5 pl-2 font-medium">Account</th>
              {periods.map((p, i) => (
                <th
                  key={p.periodKey}
                  className={`py-3.5 pr-4 text-right font-medium ${hoveredCol === i ? "bg-accent/10 text-foreground" : ""}`}
                  onMouseEnter={() => setHoveredCol(i)}
                  onMouseLeave={() => setHoveredCol(null)}
                >
                  {p.periodLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-dim/25">
              <td className="py-3.5 pl-2 font-bold">Net Worth</td>
              {periods.map((p, i) => (
                <td
                  key={p.periodKey}
                  className={`py-3.5 pr-4 text-right font-bold ${hoveredCol === i ? "bg-accent/10" : ""}`}
                  onMouseEnter={() => setHoveredCol(i)}
                  onMouseLeave={() => setHoveredCol(null)}
                >
                  {formatMoney(netWorthOf(p))}
                </td>
              ))}
            </tr>
            {/* Blank row so Assets/Liabilities read as visually separated
                groups. Filled with the page background (not the table's own
                panel color) so the gap actually reads as a gap, and its top
                edge doubles as the lighter border capping the section above. */}
            <tr aria-hidden="true">
              <td className="h-3 border-y border-dim/25 !bg-background p-0" colSpan={periods.length + 1} />
            </tr>
            <Section
              title="Assets"
              accounts={accounts.filter((a) => a.category === "asset")}
              periods={periods}
              groups={ASSET_CLASS_GROUPS}
              editableIds={editableAccountIds}
              onEdit={(a) => {
                if (a.class === "real_estate" && openHomeDrawer(a)) return;
                setDrawerAccount(a);
                setDrawerOpen(true);
              }}
              mode={dollarMode}
            />
            <tr aria-hidden="true">
              <td className="h-3 border-y border-dim/25 !bg-background p-0" colSpan={periods.length + 1} />
            </tr>
            <Section
              title="Liabilities"
              accounts={accounts.filter((a) => a.category === "liability")}
              periods={periods}
              groups={LIABILITY_CLASS_GROUPS}
              editableIds={editableAccountIds}
              onEdit={(a) => {
                if (a.class === "mortgage" && openHomeDrawer(a)) return;
                setDrawerAccount(a);
                setDrawerOpen(true);
              }}
              mode={dollarMode}
            />
          </tbody>
        </table>
        </ColHoverContext.Provider>
        </div>
        <p className="border-t border-border px-2 py-3 text-xs text-dim">
          Click an account to see its {isMonthly ? "month-by-month" : "year-by-year"}{" "}
          rollforward. A home&rsquo;s mortgage is edited as part of
          that home, not standalone. Extra Savings is the spending hub &mdash; its surplus is swept out monthly,
          so a $0 balance there is normal.
        </p>
      </div>
      <AccountDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} account={drawerAccount} people={people} accounts={accounts} />
      <HomeDrawer
        open={homeDrawer.open}
        onClose={() => setHomeDrawer({ open: false })}
        account={homeDrawer.account}
        event={homeDrawerEvent}
        accounts={accounts}
        initialMode="existing"
      />
    </div>
  );
}
