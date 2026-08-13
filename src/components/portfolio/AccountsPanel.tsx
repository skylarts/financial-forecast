"use client";

import { useState } from "react";
import type { Account } from "@/domain";
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
import { Btn } from "@/components/ui/controls";

const INPUT =
  "rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent";

/**
 * Market value the tracker would push into the forecast: positions plus
 * uninvested cash, which is what the forecast's starting balance means.
 */
function accountValue(portfolio: Portfolio, prices: PriceMap, accountId: string) {
  const { summary } = analyzePortfolio(portfolio, prices, { accountIds: [accountId] });
  return { value: summary.totalValue, costBasis: summary.costBasis };
}

const EMPTY_CASH: AccountCash = { balance: 0, opening: 0, implied: 0, solvent: true };

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

function AccountRow({
  account,
  portfolio,
  prices,
  forecastAccounts,
  onPush,
}: {
  account: PortfolioAccount;
  portfolio: Portfolio;
  prices: PriceMap;
  forecastAccounts: Account[];
  onPush: (account: PortfolioAccount, value: number, costBasis: number) => void;
}) {
  const updateAccount = usePortfolioStore((s) => s.updateAccount);
  const removeAccount = usePortfolioStore((s) => s.removeAccount);
  const linkForecastAccount = usePortfolioStore((s) => s.linkForecastAccount);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { value, costBasis } = accountValue(portfolio, prices, account.id);
  const cash = accountCashBalances(portfolio).get(account.id) ?? EMPTY_CASH;
  const linked = forecastAccounts.find((a) => a.id === account.forecastAccountId) ?? null;

  return (
    <tr className="border-b border-border-soft">
      <td className="px-3 py-2">
        <input
          value={account.name}
          onChange={(e) => updateAccount(account.id, { name: e.target.value })}
          className={`${INPUT} w-40`}
        />
      </td>
      <td className="px-3 py-2">
        <input
          value={account.institution}
          placeholder="Institution"
          onChange={(e) => updateAccount(account.id, { institution: e.target.value })}
          className={`${INPUT} w-36`}
        />
      </td>
      <td className="px-3 py-2">
        <select
          value={account.type}
          onChange={(e) => updateAccount(account.id, { type: e.target.value as PortfolioAccountType })}
          className={`${INPUT} w-44`}
        >
          {portfolioAccountTypeSchema.options.map((type) => (
            <option key={type} value={type}>
              {PORTFOLIO_ACCOUNT_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 text-right">
        <input
          type="number"
          value={account.openingCashBalance}
          onChange={(e) =>
            updateAccount(account.id, { openingCashBalance: Number(e.target.value) || 0 })
          }
          className={`${INPUT} w-24 text-right tabular-nums`}
          title="Cash the account held before its first recorded transaction. Leave at 0 when the ledger runs from the account's opening."
        />
      </td>
      <td className="px-3 py-2 text-right text-[12.5px] tabular-nums text-foreground">
        <span title={cashTitle(cash)}>{money(cash.balance)}</span>
        {cash.implied !== 0 && (
          <span className="ml-1 text-dim-2" title={cashTitle(cash)}>
            *
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right text-[12.5px] font-semibold tabular-nums text-foreground">
        {money(value)}
      </td>
      <td className="px-3 py-2">
        <select
          value={account.forecastAccountId ?? ""}
          onChange={(e) => linkForecastAccount(account.id, e.target.value || null)}
          className={`${INPUT} w-48`}
        >
          <option value="">— not linked —</option>
          {forecastAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <Btn
            onClick={() => onPush(account, value, costBasis)}
            title={
              linked
                ? `Set "${linked.name}" starting balance to ${money(value)}`
                : "Link a forecast account first"
            }
            className={linked ? "" : "pointer-events-none opacity-40"}
          >
            Push to forecast
          </Btn>
          {confirmingDelete ? (
            <>
              <Btn onClick={() => removeAccount(account.id)}>Delete</Btn>
              <Btn onClick={() => setConfirmingDelete(false)}>Keep</Btn>
            </>
          ) : (
            <Btn onClick={() => setConfirmingDelete(true)} title="Remove this account and its transactions">
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
  onPush,
}: {
  portfolio: Portfolio;
  prices: PriceMap;
  forecastAccounts: Account[];
  onPush: (account: PortfolioAccount, value: number, costBasis: number) => void;
}) {
  const addAccount = usePortfolioStore((s) => s.addAccount);

  return (
    <div className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-foreground">Accounts</h2>
          <p className="text-[12px] text-dim">
            Link an account to its counterpart in the forecast, then push this tracker&apos;s real
            market value across whenever you want the two to agree.
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
              openingCashBalance: 0,
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
              <tr className="border-b border-border">
                {[
                  "Name",
                  "Institution",
                  "Type",
                  "Opening cash",
                  "Cash",
                  "Value",
                  "Forecast account",
                  "",
                ].map((h, i) => (
                  <th
                    key={h || i}
                    className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2 ${
                      (i >= 3 && i <= 5) || i === 7 ? "text-right" : "text-left"
                    }`}
                    title={
                      i === 3
                        ? "Cash held before the ledger's first row. Leave at 0 when the ledger runs from the account's opening."
                        : i === 4
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
              {portfolio.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  portfolio={portfolio}
                  prices={prices}
                  forecastAccounts={forecastAccounts}
                  onPush={onPush}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
