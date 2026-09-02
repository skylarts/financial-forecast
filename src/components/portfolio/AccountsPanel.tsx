"use client";

import { useState } from "react";
import type { Account } from "@/domain";
import type { Person } from "@/domain/household";
import {
  PORTFOLIO_ACCOUNT_TYPE_LABELS,
  type PortfolioAccount,
} from "@/domain/portfolio";
import { accountCashBalances, type AccountCash } from "@/engine/portfolio/cash";
import { analyzePortfolio, type PriceMap } from "@/engine/portfolio/metrics";
import type { Portfolio } from "@/domain/portfolio";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { money } from "@/lib/portfolio/format";
import { ownerLabel } from "@/lib/people";
import { Btn } from "@/components/ui/controls";
import {
  accountFamilyIds,
  accountTreeRows,
  hasSleeves,
  sleevesOf,
  type AccountTreeRow,
} from "@/lib/portfolio/accountTree";
import { TAX_SOURCE_SLEEVES } from "@/lib/portfolio/taxSource";
import { useSchwabAccounts, type SchwabAccountOption } from "@/lib/portfolio/useSchwabAccounts";
import { AccountSettingsDrawer } from "./AccountSettingsDrawer";

/**
 * Market value the tracker would push into the forecast: positions plus
 * uninvested cash, which is what the forecast's starting balance means.
 *
 * Scoped to a list of ids rather than one, so a split account's parent row can
 * total itself and its sleeves in the single pass that produces every other
 * figure on that row.
 */
function accountValue(portfolio: Portfolio, prices: PriceMap, accountIds: string[]) {
  const { summary } = analyzePortfolio(portfolio, prices, { accountIds });
  return { value: summary.totalValue, costBasis: summary.costBasis };
}

const EMPTY_CASH: AccountCash = { balance: 0, opening: 0, implied: 0, solvent: true };

/** Cash across a whole family, so a parent row reports what its sleeves hold. */
function familyCash(portfolio: Portfolio, accountIds: string[]): AccountCash {
  const balances = accountCashBalances(portfolio);
  return accountIds.reduce<AccountCash>((sum, id) => {
    const cash = balances.get(id) ?? EMPTY_CASH;
    return {
      balance: sum.balance + cash.balance,
      opening: sum.opening + cash.opening,
      implied: sum.implied + cash.implied,
      solvent: sum.solvent && cash.solvent,
    };
  }, EMPTY_CASH);
}

/**
 * Why the cash figure is what it is. Worth spelling out only when the ledger
 * needed help: a balance replayed from a complete ledger is just the balance,
 * and explaining it would be noise on every row.
 */
function cashTitle(cash: AccountCash): string {
  if (!cash.solvent) {
    return "This ledger records trades but not the deposits that funded them, so this balance is inferred rather than counted. Import the account's cash activity to make it exact.";
  }
  if (cash.implied !== 0) {
    return `Replayed from the ledger, seeded with ${money(
      cash.opening + cash.implied,
    )} — ${money(cash.implied)} of that is implied by spending recorded before the first deposit. Set the opening cash to what the first statement shows and this goes away.`;
  }
  return "Replayed from every cash movement in the ledger.";
}

/**
 * The dollars sitting on a split account's own ledger rather than on one of
 * its sleeves -- money that has not been attributed to pre-tax or Roth yet.
 *
 * Worth its own figure because it is precisely what the forecast is not being
 * told about: a parent never syncs (see `pendingForecastPushes`), so anything
 * left here is real money the plan cannot see. Surfacing it turns a silent
 * omission into a visible to-do.
 */
function unassignedValue(portfolio: Portfolio, prices: PriceMap, parentId: string) {
  const holdsOwnRows = portfolio.transactions.some((tx) => tx.accountId === parentId);
  if (!holdsOwnRows) return 0;
  return accountValue(portfolio, prices, [parentId]).value;
}

/**
 * One account, read rather than edited.
 *
 * Everything that used to be a control in this row -- institution, type,
 * owner, opening cash, both link pickers, the sync checkbox, split and delete
 * -- now lives in the settings drawer. What stays is what someone scanning the
 * page came for: whose account this is, what it holds, and whether the
 * forecast is hearing about it.
 */
function AccountRow({
  row,
  accounts,
  portfolio,
  prices,
  forecastAccounts,
  people,
  schwabAccounts,
  onPush,
  onOpenSettings,
}: {
  row: AccountTreeRow;
  accounts: readonly PortfolioAccount[];
  portfolio: Portfolio;
  prices: PriceMap;
  forecastAccounts: Account[];
  people: readonly Person[];
  schwabAccounts: SchwabAccountOption[] | null;
  onPush: (account: PortfolioAccount, value: number, costBasis: number) => void;
  onOpenSettings: () => void;
}) {
  const { account, depth, isParent } = row;

  // A parent stands for everything beneath it, so its figures cover the whole
  // family. Every other row is only ever itself.
  const scopeIds = isParent ? accountFamilyIds(accounts, account.id) : [account.id];
  const { value, costBasis } = accountValue(portfolio, prices, scopeIds);
  const cash = isParent
    ? familyCash(portfolio, scopeIds)
    : accountCashBalances(portfolio).get(account.id) ?? EMPTY_CASH;
  const linked = forecastAccounts.find((a) => a.id === account.forecastAccountId) ?? null;
  const unassigned = isParent ? unassignedValue(portfolio, prices, account.id) : 0;
  const sleeveCount = isParent ? sleevesOf(accounts, account.id).length : 0;
  const schwab = account.schwabAccountHash
    ? schwabAccounts?.find((s) => s.hashValue === account.schwabAccountHash) ?? null
    : null;

  // The account's own line of description, assembled from whatever has been
  // filled in -- an empty institution shouldn't leave a dangling separator.
  const details = [
    account.institution.trim(),
    PORTFOLIO_ACCOUNT_TYPE_LABELS[account.type],
    ownerLabel(people, account.ownerId),
  ].filter(Boolean);

  return (
    <tr className="border-b border-border-soft align-middle">
      <td className={`py-2.5 pr-3 ${depth > 0 ? "pl-6" : "pl-2"}`}>
        <div className={depth > 0 ? "border-l-2 border-accent/40 pl-3" : ""}>
          <div className="text-[13px] font-medium text-foreground">{account.name}</div>
          <div className="mt-0.5 text-[11px] text-dim-2">
            {details.join(" · ")}
            {isParent && ` · ${sleeveCount} sleeve${sleeveCount === 1 ? "" : "s"}`}
            {schwab && ` · Schwab ${schwab.masked}`}
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 text-right text-[12.5px] tabular-nums text-dim">
        <span title={cashTitle(cash)}>{money(cash.balance)}</span>
        {cash.implied !== 0 && (
          <span className="ml-1 text-dim-2" title={cashTitle(cash)}>
            *
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right text-[13px] font-semibold tabular-nums text-foreground">
        {money(value)}
        {isParent && <div className="text-[11px] font-normal text-dim-2">incl. sleeves</div>}
      </td>
      <td className="px-3 py-2.5">
        {isParent ? (
          <span
            className="text-[12px] italic text-dim-2"
            title="A split account's sleeves each carry their own tax treatment, so each one links to its own forecast account. Linking the parent as well would push the same dollars a second time."
          >
            Linked per sleeve
          </span>
        ) : linked ? (
          <>
            <div className="text-[12.5px] text-foreground">{linked.name}</div>
            <div className="text-[11px] text-dim-2">
              {account.syncToForecast ? "Kept up to date" : "Pushed by hand"}
            </div>
          </>
        ) : (
          <span className="text-[12px] text-dim-2">Not linked</span>
        )}
        {unassigned !== 0 && (
          <p
            className="mt-1 text-[11px] text-negative"
            title="These rows sit on the account itself rather than on one of its sleeves, so nothing says whether they are pre-tax or Roth — and the forecast is not told about them at all. Move them onto a sleeve from the Transactions tab."
          >
            {money(unassigned)} unassigned
          </p>
        )}
      </td>
      <td className="whitespace-nowrap py-2.5 pl-3 pr-2 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {!isParent && linked && (
            <Btn
              onClick={() => onPush(account, value, costBasis)}
              className="px-2"
              title={`Set "${linked.name}" starting balance to ${money(value)}`}
            >
              Push
            </Btn>
          )}
          <Btn
            onClick={onOpenSettings}
            className="px-2"
            title={`Settings for ${account.name} — links, owner, type and removal`}
          >
            <span aria-hidden>⚙</span>
            <span className="sr-only">Settings</span>
          </Btn>
        </div>
      </td>
    </tr>
  );
}

export function AccountsPanel({
  portfolio,
  prices,
  forecastAccounts,
  people,
  onPush,
}: {
  portfolio: Portfolio;
  prices: PriceMap;
  forecastAccounts: Account[];
  people: readonly Person[];
  onPush: (account: PortfolioAccount, value: number, costBasis: number) => void;
}) {
  const addAccount = usePortfolioStore((s) => s.addAccount);
  const anySplit = portfolio.accounts.some((a) => hasSleeves(portfolio.accounts, a.id));
  const schwabAccounts = useSchwabAccounts();
  const [settingsFor, setSettingsFor] = useState<string | null>(null);

  const rows = accountTreeRows(portfolio.accounts);
  // Read from the live list rather than held in state, so an edit made in the
  // drawer is what the drawer goes on showing.
  const editing = rows.find((r) => r.account.id === settingsFor) ?? null;

  return (
    <div className="p-3 sm:p-5">
      {/* Heading and its action share the top line; the explanation sits under
          both. Wrapping the paragraph in beside the button squeezed "Add
          account" into a two-line sliver of a button. */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-semibold text-foreground">Accounts</h2>
          <Btn
            variant="primary"
            onClick={() =>
              addAccount({
              name: "New account",
              institution: "",
              type: "taxable",
              forecastAccountId: null,
              syncToForecast: true,
              ownerId: null,
              openingCashBalance: 0,
              parentAccountId: null,
              schwabAccountHash: null,
            })
          }
          >
            <span className="whitespace-nowrap">Add account</span>
          </Btn>
        </div>
        <p className="max-w-2xl text-[12px] text-dim">
          Each account can be linked to its counterpart in the forecast, so this tracker&apos;s
          real market value becomes the plan&apos;s starting balance. Open an account&apos;s
          settings to change its links, owner or type.
        </p>
      </div>

      {portfolio.accounts.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">
          No accounts yet. Add one to start tracking holdings.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                {[
                  { label: "Account", align: "text-left" },
                  {
                    label: "Cash",
                    align: "text-right",
                    title:
                      "Replayed from the ledger's own deposits, trades, dividends and fees — not typed in.",
                  },
                  { label: "Value", align: "text-right" },
                  { label: "Forecast", align: "text-left" },
                  { label: "", align: "text-right" },
                ].map((h, i) => (
                  <th
                    key={h.label || i}
                    title={h.title}
                    className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2 ${h.align}`}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AccountRow
                  key={row.account.id}
                  row={row}
                  accounts={portfolio.accounts}
                  portfolio={portfolio}
                  prices={prices}
                  forecastAccounts={forecastAccounts}
                  people={people}
                  schwabAccounts={schwabAccounts}
                  onPush={onPush}
                  onOpenSettings={() => setSettingsFor(row.account.id)}
                />
              ))}
            </tbody>
          </table>
          {anySplit && (
            <p className="mt-3 text-[11px] text-dim">
              A split account&apos;s value totals its sleeves. Only the sleeves link to the
              forecast, so the {TAX_SOURCE_SLEEVES.map((s) => s.name).join(" and ")} halves each
              land in the account that taxes them correctly.
            </p>
          )}
        </div>
      )}

      {editing && (
        <AccountSettingsDrawer
          key={editing.account.id}
          account={editing.account}
          accounts={portfolio.accounts}
          forecastAccounts={forecastAccounts}
          people={people}
          schwabAccounts={schwabAccounts}
          isParent={editing.isParent}
          sleeveCount={
            editing.isParent ? sleevesOf(portfolio.accounts, editing.account.id).length : 0
          }
          {...accountValue(
            portfolio,
            prices,
            editing.isParent
              ? accountFamilyIds(portfolio.accounts, editing.account.id)
              : [editing.account.id],
          )}
          unassigned={
            editing.isParent ? unassignedValue(portfolio, prices, editing.account.id) : 0
          }
          onPush={onPush}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </div>
  );
}
