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
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { money } from "@/lib/portfolio/format";
import { ownerOptions } from "@/lib/people";
import { Btn } from "@/components/ui/controls";
import { Drawer } from "@/components/ui/Drawer";
import { assertAssignableParent } from "@/lib/portfolio/accountTree";
import { TAX_SOURCE_SLEEVES } from "@/lib/portfolio/taxSource";
import type { SchwabAccountOption } from "@/lib/portfolio/useSchwabAccounts";

/**
 * Everything about one account that is set rather than read.
 *
 * It lives behind a per-row button because of what the accounts table became:
 * nine columns, most of them form controls for decisions made once and then
 * never again -- which institution, which forecast account, which Schwab
 * account. Reading the table meant reading past all of it. The table now shows
 * the money and the state; this is where the state gets changed.
 */

const INPUT =
  "w-full rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border-soft pt-4 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-dim">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-dim-2">{hint}</span>}
    </label>
  );
}

export function AccountSettingsDrawer({
  account,
  accounts,
  forecastAccounts,
  people,
  schwabAccounts,
  isParent,
  sleeveCount,
  value,
  costBasis,
  unassigned,
  onPush,
  onClose,
}: {
  account: PortfolioAccount;
  accounts: readonly PortfolioAccount[];
  forecastAccounts: Account[];
  people: readonly Person[];
  schwabAccounts: SchwabAccountOption[] | null;
  isParent: boolean;
  sleeveCount: number;
  value: number;
  costBasis: number;
  unassigned: number;
  onPush: (account: PortfolioAccount, value: number, costBasis: number) => void;
  onClose: () => void;
}) {
  const updateAccount = usePortfolioStore((s) => s.updateAccount);
  const removeAccount = usePortfolioStore((s) => s.removeAccount);
  const linkForecastAccount = usePortfolioStore((s) => s.linkForecastAccount);
  const splitByTaxSource = usePortfolioStore((s) => s.splitByTaxSource);
  const [parentError, setParentError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const linked = forecastAccounts.find((a) => a.id === account.forecastAccountId) ?? null;
  // Only accounts that could legally take this one as a sleeve, so the list
  // cannot offer a choice that would just be rejected.
  const parentCandidates = accounts.filter(
    (a) => a.id !== account.id && assertAssignableParent(accounts, account.id, a.id) === null,
  );
  // Hides an already-linked Schwab account from every other account's picker,
  // so two internal accounts can't end up pointed at the same brokerage
  // account by mistake -- a mistake here lands fetched rows in the wrong place.
  const claimedSchwabHashes = new Set(
    accounts
      .filter((a) => a.id !== account.id && a.schwabAccountHash)
      .map((a) => a.schwabAccountHash),
  );
  // Splitting only makes sense for an account that is neither already split
  // nor itself a sleeve.
  const canSplit = !isParent && account.parentAccountId === null;

  return (
    <Drawer open title="Account settings" onClose={onClose}>
      <div className="space-y-4">
        <Section title="Details">
          <Field label="Name">
            <input
              value={account.name}
              onChange={(e) => updateAccount(account.id, { name: e.target.value })}
              className={INPUT}
            />
          </Field>
          <Field label="Institution">
            <input
              value={account.institution}
              placeholder="Charles Schwab, Empower, …"
              onChange={(e) => updateAccount(account.id, { institution: e.target.value })}
              className={INPUT}
            />
          </Field>
          <Field label="Type" hint="How the money is taxed, which is what the forecast reads.">
            <select
              value={account.type}
              onChange={(e) =>
                updateAccount(account.id, { type: e.target.value as PortfolioAccountType })
              }
              className={INPUT}
            >
              {portfolioAccountTypeSchema.options.map((type) => (
                <option key={type} value={type}>
                  {PORTFOLIO_ACCOUNT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Owner">
            <select
              value={account.ownerId ?? ""}
              onChange={(e) => updateAccount(account.id, { ownerId: e.target.value || null })}
              className={INPUT}
            >
              {ownerOptions(people).map((o) => (
                <option key={o.value || "joint"} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Opening cash"
            hint="Cash the account held before its first recorded transaction. Leave at 0 when the ledger runs from the account's opening."
          >
            <input
              type="number"
              value={account.openingCashBalance}
              onChange={(e) =>
                updateAccount(account.id, { openingCashBalance: Number(e.target.value) || 0 })
              }
              className={`${INPUT} tabular-nums`}
            />
          </Field>
        </Section>

        <Section title="Structure">
          {isParent ? (
            <p className="text-[12px] text-dim">
              Split into {sleeveCount} sleeve{sleeveCount === 1 ? "" : "s"}. Each sleeve carries its
              own tax treatment and links to its own forecast account; this account totals them.
            </p>
          ) : (
            <>
              {(parentCandidates.length > 0 || account.parentAccountId !== null) && (
                <Field
                  label="Part of"
                  hint="A sleeve is one half of an account holding both pre-tax and Roth money, so each half can carry its own tax treatment into the forecast."
                >
                  <select
                    value={account.parentAccountId ?? ""}
                    onChange={(e) => {
                      const parentAccountId = e.target.value || null;
                      const problem = assertAssignableParent(
                        accounts,
                        account.id,
                        parentAccountId,
                      );
                      setParentError(problem);
                      if (problem) return;
                      updateAccount(account.id, { parentAccountId });
                    }}
                    className={INPUT}
                  >
                    <option value="">Its own account</option>
                    {parentCandidates.map((a) => (
                      <option key={a.id} value={a.id}>
                        Part of {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {parentError && <p className="text-[11px] text-negative">{parentError}</p>}
              {canSplit && (
                <div>
                  <Btn
                    onClick={() => splitByTaxSource(account.id)}
                    title="Existing transactions stay on the account until you assign them, so nothing is guessed at."
                  >
                    Split into {TAX_SOURCE_SLEEVES.map((s) => s.name).join(" and ")} sleeves
                  </Btn>
                  <p className="mt-1 text-[11px] text-dim-2">
                    For a 401(k) or 457 holding both kinds of money. Existing transactions stay on
                    the account until you assign them.
                  </p>
                </div>
              )}
            </>
          )}
        </Section>

        <Section title="Forecast">
          {isParent ? (
            <p className="text-[12px] text-dim">
              A split account links per sleeve — linking this one as well would push the same
              dollars a second time.
            </p>
          ) : (
            <>
              <Field label="Linked forecast account">
                <select
                  value={account.forecastAccountId ?? ""}
                  onChange={(e) => {
                    const forecastAccountId = e.target.value || null;
                    // An account not yet assigned to anyone here picks up its
                    // forecast counterpart's owner rather than staying blank --
                    // the forecast side already knows whose account this is, and
                    // an owner set explicitly beforehand always wins (only
                    // adopted when account.ownerId is still null, and only when
                    // there's an owner to adopt).
                    const target = forecastAccountId
                      ? forecastAccounts.find((a) => a.id === forecastAccountId)
                      : null;
                    linkForecastAccount(
                      account.id,
                      forecastAccountId,
                      account.ownerId === null && target ? target.ownerId : undefined,
                    );
                  }}
                  className={INPUT}
                >
                  <option value="">— not linked —</option>
                  {forecastAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>

              <label className="flex items-start gap-2 text-[12px] text-dim">
                <input
                  type="checkbox"
                  checked={account.syncToForecast}
                  disabled={!account.forecastAccountId}
                  onChange={(e) =>
                    updateAccount(account.id, { syncToForecast: e.target.checked })
                  }
                  className="mt-0.5"
                />
                <span>
                  Keep the forecast up to date automatically
                  <span className="mt-0.5 block text-[11px] text-dim-2">
                    Writes this account&apos;s value into the forecast whenever it changes. Turn it
                    off to keep the link but push by hand.
                  </span>
                </span>
              </label>

              <div>
                <Btn
                  onClick={() => onPush(account, value, costBasis)}
                  className={linked ? "" : "pointer-events-none opacity-40"}
                  title={
                    linked
                      ? `Set "${linked.name}" starting balance to ${money(value)}`
                      : "Link a forecast account first"
                  }
                >
                  Push {money(value)} to the forecast
                </Btn>
              </div>
            </>
          )}

          {unassigned !== 0 && (
            <p className="text-[11.5px] text-negative">
              {money(unassigned)} sits on this account rather than on a sleeve, so nothing says
              whether it is pre-tax or Roth and the forecast is not told about it at all. Move
              those rows onto a sleeve from the Transactions tab.
            </p>
          )}
        </Section>

        {/* A sleeve has no Schwab account of its own -- the account number
            belongs to the family as a whole, and rows reach a sleeve by
            tax-source routing at import time instead. */}
        {schwabAccounts && schwabAccounts.length > 0 && account.parentAccountId === null && (
          <Section title="Schwab">
            <Field
              label="Schwab account"
              hint="Fetching from that account lands its rows here without asking each time."
            >
              <select
                value={account.schwabAccountHash ?? ""}
                onChange={(e) =>
                  updateAccount(account.id, { schwabAccountHash: e.target.value || null })
                }
                className={INPUT}
              >
                <option value="">— not linked —</option>
                {schwabAccounts
                  .filter(
                    (s) =>
                      s.hashValue === account.schwabAccountHash ||
                      !claimedSchwabHashes.has(s.hashValue),
                  )
                  .map((s) => (
                    <option key={s.hashValue} value={s.hashValue}>
                      Schwab {s.masked}
                    </option>
                  ))}
              </select>
            </Field>
          </Section>
        )}

        <Section title="Remove">
          {confirmingDelete ? (
            <div className="space-y-2">
              <p className="text-[12px] text-dim">
                {isParent
                  ? `This removes the account, its ${sleeveCount} sleeve${
                      sleeveCount === 1 ? "" : "s"
                    }, and all of their transactions.`
                  : "This removes the account and all of its transactions."}
              </p>
              <div className="flex gap-2">
                <Btn
                  onClick={() => {
                    removeAccount(account.id);
                    onClose();
                  }}
                >
                  Delete account
                </Btn>
                <Btn onClick={() => setConfirmingDelete(false)}>Keep it</Btn>
              </div>
            </div>
          ) : (
            <Btn onClick={() => setConfirmingDelete(true)}>Remove this account…</Btn>
          )}
        </Section>
      </div>
    </Drawer>
  );
}
