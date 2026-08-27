"use client";

import { useState } from "react";
import type { Account } from "@/domain";
import type { Person } from "@/domain/household";
import {
  PORTFOLIO_ACCOUNT_TYPE_LABELS,
  portfolioAccountTypeSchema,
  type PortfolioAccount,
  type PortfolioAccountType,
} from "@/domain/portfolio";
import { accountCashBalances, type AccountCash } from "@/engine/portfolio/cash";
import { analyzePortfolio, type PriceMap } from "@/engine/portfolio/metrics";
import type { Portfolio } from "@/domain/portfolio";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { money } from "@/lib/portfolio/format";
import { ownerOptions } from "@/lib/people";
import { Btn } from "@/components/ui/controls";
import {
  accountFamilyIds,
  accountTreeRows,
  assertAssignableParent,
  hasSleeves,
  sleevesOf,
  type AccountTreeRow,
} from "@/lib/portfolio/accountTree";
import { TAX_SOURCE_SLEEVES } from "@/lib/portfolio/taxSource";

const INPUT =
  "rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent";

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

/** The select that attaches an account to a parent, or detaches it. */
function ParentPicker({
  account,
  accounts,
}: {
  account: PortfolioAccount;
  accounts: readonly PortfolioAccount[];
}) {
  const updateAccount = usePortfolioStore((s) => s.updateAccount);
  const [error, setError] = useState<string | null>(null);

  // Only accounts that could legally take this one as a sleeve, so the list
  // cannot offer a choice that would just be rejected.
  const candidates = accounts.filter(
    (a) => a.id !== account.id && assertAssignableParent(accounts, account.id, a.id) === null,
  );
  if (candidates.length === 0 && account.parentAccountId === null) return null;

  return (
    <>
      <select
        value={account.parentAccountId ?? ""}
        onChange={(e) => {
          const parentAccountId = e.target.value || null;
          const problem = assertAssignableParent(accounts, account.id, parentAccountId);
          setError(problem);
          if (problem) return;
          updateAccount(account.id, { parentAccountId });
        }}
        className="mt-0.5 max-w-[10rem] cursor-pointer rounded border border-transparent bg-transparent py-0.5 text-[11px] text-dim-2 outline-none hover:text-foreground focus:border-accent focus:text-foreground"
        title="Make this account a sleeve of another — how a 401(k) or 457 holding both pre-tax and Roth money is split, so each half can carry its own tax treatment into the forecast."
      >
        <option value="">Its own account</option>
        {candidates.map((a) => (
          <option key={a.id} value={a.id}>
            Part of {a.name}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 max-w-[10rem] text-[11px] text-negative">{error}</p>}
    </>
  );
}

function AccountRow({
  row,
  accounts,
  portfolio,
  prices,
  forecastAccounts,
  people,
  onPush,
}: {
  row: AccountTreeRow;
  accounts: readonly PortfolioAccount[];
  portfolio: Portfolio;
  prices: PriceMap;
  forecastAccounts: Account[];
  people: readonly Person[];
  onPush: (account: PortfolioAccount, value: number, costBasis: number) => void;
}) {
  const { account, depth, isParent } = row;
  const updateAccount = usePortfolioStore((s) => s.updateAccount);
  const removeAccount = usePortfolioStore((s) => s.removeAccount);
  const linkForecastAccount = usePortfolioStore((s) => s.linkForecastAccount);
  const splitByTaxSource = usePortfolioStore((s) => s.splitByTaxSource);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // A parent stands for everything beneath it, so its figures cover the whole
  // family. Every other row is only ever itself.
  const scopeIds = isParent ? accountFamilyIds(accounts, account.id) : [account.id];
  const { value, costBasis } = accountValue(portfolio, prices, scopeIds);
  const cash = isParent
    ? familyCash(portfolio, scopeIds)
    : accountCashBalances(portfolio).get(account.id) ?? EMPTY_CASH;
  const linked = forecastAccounts.find((a) => a.id === account.forecastAccountId) ?? null;
  const unassigned = isParent ? unassignedValue(portfolio, prices, account.id) : 0;

  // Splitting only makes sense for an account that is neither already split
  // nor itself a sleeve.
  const canSplit = !isParent && account.parentAccountId === null;
  const sleeveCount = isParent ? sleevesOf(accounts, account.id).length : 0;

  return (
    <tr className="border-b border-border-soft align-middle">
      <td className={`sticky left-0 z-10 border-r border-border-soft bg-panel py-2 pr-2 ${depth > 0 ? "pl-6" : "pl-2"}`}>
        <div className={depth > 0 ? "border-l-2 border-accent/40 pl-3" : ""}>
          <input
            value={account.name}
            onChange={(e) => updateAccount(account.id, { name: e.target.value })}
            className={`${INPUT} w-36`}
          />
          {isParent ? (
            <p className="mt-0.5 text-[11px] text-dim-2">
              {sleeveCount} sleeve{sleeveCount === 1 ? "" : "s"}
            </p>
          ) : (
            <ParentPicker account={account} accounts={accounts} />
          )}
        </div>
      </td>
      <td className="px-2 py-2">
        <input
          value={account.institution}
          placeholder="Institution"
          onChange={(e) => updateAccount(account.id, { institution: e.target.value })}
          className={`${INPUT} w-28`}
        />
      </td>
      <td className="px-2 py-2">
        <select
          value={account.type}
          onChange={(e) => updateAccount(account.id, { type: e.target.value as PortfolioAccountType })}
          className={`${INPUT} w-36`}
        >
          {portfolioAccountTypeSchema.options.map((type) => (
            <option key={type} value={type}>
              {PORTFOLIO_ACCOUNT_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-2">
        <select
          value={account.ownerId ?? ""}
          onChange={(e) => updateAccount(account.id, { ownerId: e.target.value || null })}
          className={`${INPUT} w-24`}
        >
          {ownerOptions(people).map((o) => (
            <option key={o.value || "joint"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number"
          value={account.openingCashBalance}
          onChange={(e) =>
            updateAccount(account.id, { openingCashBalance: Number(e.target.value) || 0 })
          }
          className={`${INPUT} w-20 text-right tabular-nums`}
          title="Cash the account held before its first recorded transaction. Leave at 0 when the ledger runs from the account's opening."
        />
      </td>
      <td className="px-2 py-2 text-right text-[12.5px] tabular-nums text-foreground">
        <span title={cashTitle(cash)}>{money(cash.balance)}</span>
        {cash.implied !== 0 && (
          <span className="ml-1 text-dim-2" title={cashTitle(cash)}>
            *
          </span>
        )}
      </td>
      <td className="px-2 py-2 text-right text-[12.5px] font-semibold tabular-nums text-foreground">
        {money(value)}
        {isParent && <div className="text-[11px] font-normal text-dim-2">incl. sleeves</div>}
      </td>
      <td className="px-2 py-2">
        {isParent ? (
          <p
            className="w-36 text-[11px] italic text-dim-2"
            title="A split account's sleeves each carry their own tax treatment, so each one links to its own forecast account. Linking the parent as well would push the same dollars a second time."
          >
            Linked per sleeve
          </p>
        ) : (
          <div className="flex items-center gap-1.5">
            <select
              value={account.forecastAccountId ?? ""}
              onChange={(e) => {
                const forecastAccountId = e.target.value || null;
                // An account not yet assigned to anyone here picks up its
                // forecast counterpart's owner rather than staying blank --
                // the forecast side already knows whose account this is, and
                // an owner set explicitly beforehand always wins (only adopted
                // when account.ownerId is still null, and only when there's an
                // owner to adopt).
                const target = forecastAccountId
                  ? forecastAccounts.find((a) => a.id === forecastAccountId)
                  : null;
                linkForecastAccount(
                  account.id,
                  forecastAccountId,
                  account.ownerId === null && target ? target.ownerId : undefined,
                );
              }}
              className={`${INPUT} w-40`}
            >
              <option value="">— not linked —</option>
              {forecastAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <input
              type="checkbox"
              checked={account.syncToForecast}
              disabled={!account.forecastAccountId}
              onChange={(e) => updateAccount(account.id, { syncToForecast: e.target.checked })}
              aria-label="Sync this account's value into the forecast automatically"
              title="Automatically write this account's value into the forecast whenever it changes. Uncheck to keep the link without the automatic write."
            />
          </div>
        )}
        {unassigned !== 0 && (
          <p
            className="mt-1 w-36 text-[11px] text-negative"
            title="These rows sit on the account itself rather than on one of its sleeves, so nothing says whether they are pre-tax or Roth — and the forecast is not told about them at all. Move them onto a sleeve from the Transactions tab."
          >
            {money(unassigned)} unassigned
          </p>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {canSplit && (
            <Btn
              onClick={() => splitByTaxSource(account.id)}
              className="px-2"
              title="Split this account into a pre-tax and a Roth sleeve, so each half can carry its own tax treatment into the forecast. Existing transactions stay on the account until you assign them, so nothing is guessed at."
            >
              Split
            </Btn>
          )}
          {!isParent && (
            <Btn
              onClick={() => onPush(account, value, costBasis)}
              className={`px-2 ${linked ? "" : "pointer-events-none opacity-40"}`}
              title={
                linked
                  ? `Set "${linked.name}" starting balance to ${money(value)}`
                  : "Link a forecast account first"
              }
            >
              Push
            </Btn>
          )}
          {confirmingDelete ? (
            <>
              <Btn onClick={() => removeAccount(account.id)} className="px-2">
                Delete
              </Btn>
              <Btn onClick={() => setConfirmingDelete(false)} className="px-2">
                Keep
              </Btn>
            </>
          ) : (
            <Btn
              onClick={() => setConfirmingDelete(true)}
              className="px-2"
              title={
                isParent
                  ? `Remove this account, its ${sleeveCount} sleeve${sleeveCount === 1 ? "" : "s"}, and all their transactions`
                  : "Remove this account and its transactions"
              }
            >
              ✕
            </Btn>
          )}
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

  return (
    <div className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-foreground">Accounts</h2>
          <p className="text-[12px] text-dim">
            Link an account to its counterpart in the forecast, then push this tracker&apos;s real
            market value across whenever you want the two to agree.
          </p>
          <p className="mt-0.5 text-[12px] text-dim">
            A 401(k) or 457 holding both pre-tax and Roth money splits into two sleeves — one per
            tax treatment — so each half reaches the forecast account that taxes it correctly.
          </p>
        </div>
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
            })
          }
        >
          Add account
        </Btn>
      </div>

      {portfolio.accounts.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">
          No accounts yet. Add one to start tracking holdings.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="sticky top-0 z-10 border-b border-border bg-panel">
                {[
                  "Name",
                  "Institution",
                  "Type",
                  "Owner",
                  "Opening cash",
                  "Cash",
                  "Value",
                  "Forecast account",
                  "",
                ].map((h, i) => (
                  <th
                    key={h || i}
                    className={`px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2 ${
                      (i >= 4 && i <= 6) || i === 8 ? "text-right" : "text-left"
                    } ${i === 0 ? "sticky left-0 z-20 border-r border-border-soft bg-panel" : ""}`}
                    title={
                      i === 4
                        ? "Cash held before the ledger's first row. Leave at 0 when the ledger runs from the account's opening."
                        : i === 5
                          ? "Replayed from the ledger's own deposits, trades, dividends and fees — not typed in."
                          : undefined
                    }
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accountTreeRows(portfolio.accounts).map((row) => (
                <AccountRow
                  key={row.account.id}
                  row={row}
                  accounts={portfolio.accounts}
                  portfolio={portfolio}
                  prices={prices}
                  forecastAccounts={forecastAccounts}
                  people={people}
                  onPush={onPush}
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
    </div>
  );
}
