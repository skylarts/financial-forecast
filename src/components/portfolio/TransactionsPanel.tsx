"use client";

import { Fragment, useMemo, useState } from "react";
import {
  opensLotOn,
  closesLotOn,
  formatOptionSymbol,
  isOptionLifecycleType,
  normalizeSymbol,
  parseLotIds,
  signedCashFlow,
  signedQuantity,
  signedTransactionAmount,
  TRANSACTION_TYPE_GROUPS,
  TRANSACTION_TYPE_LABELS,
  type Portfolio,
  type PortfolioAccount,
  type Transaction,
  type TransactionType,
} from "@/domain/portfolio";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { money, price, shares, shortDate, toneFor } from "@/lib/portfolio/format";
import { Btn, Segmented } from "@/components/ui/controls";
import { SymbolField } from "./SymbolField";
import { sortMarker, useSort, type SortAccessors } from "./useSort";
import { buildGroups, GroupHeaderRow, GroupToggles, useCollapsedGroups } from "./grouping";

const TX_GROUPINGS = [
  { value: "none", label: "Flat" },
  { value: "symbol", label: "By stock" },
  { value: "account", label: "By account" },
  { value: "type", label: "By type" },
  { value: "month", label: "By month" },
] as const;

type TxGrouping = (typeof TX_GROUPINGS)[number]["value"];

const INPUT =
  "rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent";
const HEAD = "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

type TxColumn = "date" | "account" | "type" | "symbol" | "quantity" | "price" | "amount" | "lot";

function TxSortHeader({
  label,
  column,
  align,
  sort,
  onToggle,
}: {
  label: string;
  column: TxColumn;
  align: "left" | "right";
  sort: { key: TxColumn; direction: "asc" | "desc" };
  onToggle: (column: TxColumn) => void;
}) {
  const alignClass = align === "left" ? "text-left" : "text-right";
  return (
    <th className={`${HEAD} ${alignClass}`}>
      <button
        type="button"
        onClick={() => onToggle(column)}
        title={`Sort by ${label.toLowerCase()}`}
        className={`w-full ${alignClass} uppercase tracking-wide transition-colors hover:text-foreground ${
          sort.key === column ? "text-foreground" : ""
        }`}
      >
        {label}
        {sortMarker(sort, column)}
      </button>
    </th>
  );
}

interface TxFormState {
  accountId: string;
  date: string;
  type: TransactionType;
  symbol: string;
  quantity: string;
  price: string;
  amount: string;
  fees: string;
  lotId: string;
  acquiredDate: string;
}

function blankForm(accountId: string): TxFormState {
  return {
    accountId,
    date: new Date().toISOString().slice(0, 10),
    type: "buy",
    symbol: "",
    quantity: "",
    price: "",
    amount: "",
    fees: "",
    lotId: "",
    acquiredDate: "",
  };
}

/** Converts a stored transaction back into editable form strings. */
function formFromTransaction(tx: Transaction): TxFormState {
  return {
    accountId: tx.accountId,
    date: tx.date,
    type: tx.type,
    symbol: tx.symbol ?? "",
    quantity: tx.quantity > 0 ? String(tx.quantity) : "",
    price: tx.price > 0 ? String(tx.price) : "",
    amount: tx.amount === null ? "" : String(tx.amount),
    fees: tx.fees > 0 ? String(tx.fees) : "",
    lotId: tx.lotId ?? "",
    acquiredDate: tx.acquiredDate ?? "",
  };
}

/**
 * The add and edit forms are the same fields end to end, so they share one
 * component -- keeping them separate would mean every future field (or every
 * future bug) has to be fixed twice.
 */
function TransactionForm({
  accounts,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  /** After a successful add, clear everything but account/date/type -- a
   *  statement is almost always entered as a run of similar rows. Editing
   *  never sets this: there is exactly one save, and it should close. */
  resetAfterSubmit = false,
}: {
  accounts: PortfolioAccount[];
  initial: TxFormState;
  submitLabel: string;
  onSubmit: (form: TxFormState) => void;
  onCancel: () => void;
  resetAfterSubmit?: boolean;
}) {
  const [form, setForm] = useState(initial);

  const set = (patch: Partial<TxFormState>) => setForm((f) => ({ ...f, ...patch }));

  const needsSymbol =
    form.type !== "cash_deposit" &&
    form.type !== "cash_withdrawal" &&
    form.type !== "interest" &&
    form.type !== "fee";
  const canSubmit = form.date !== "" && form.accountId !== "" && (!needsSymbol || form.symbol.trim() !== "");
  const opensLot = opensLotOn(form.type) !== null;
  const closesLot = closesLotOn(form.type) !== null;
  const lotHint = closesLot
    ? "Which lots this trade closes. Left blank it fills in oldest-first; clear it any time to re-derive. Separate several lots with commas."
    : opensLot
      ? "This lot's name. Left blank one is generated from the symbol and date."
      : "Only buys and sells carry a lot.";

  return (
    <div className="mb-4 rounded-md border border-border bg-panel-2 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Account</span>
          <select
            value={form.accountId}
            onChange={(e) => set({ accountId: e.target.value })}
            className={`${INPUT} w-36`}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Date</span>
          <input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} className={INPUT} />
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Type</span>
          <select
            value={form.type}
            onChange={(e) => set({ type: e.target.value as TransactionType })}
            className={INPUT}
          >
            {TRANSACTION_TYPE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.types.map((type) => (
                  <option key={type} value={type}>
                    {TRANSACTION_TYPE_LABELS[type]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {needsSymbol && (
        <div className="mt-2 flex">
          <SymbolField value={form.symbol} onChange={(symbol) => set({ symbol })} />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">
            {form.type === "split" ? "Ratio" : isOptionLifecycleType(form.type) ? "Contracts" : "Shares"}
          </span>
          <input
            value={form.quantity}
            onChange={(e) => set({ quantity: e.target.value })}
            placeholder={form.type === "split" ? "2" : isOptionLifecycleType(form.type) ? "1" : "10"}
            className={`${INPUT} w-24 text-right`}
          />
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Price</span>
          <input
            value={form.price}
            onChange={(e) => set({ price: e.target.value })}
            // Retiring a contract carries no price of its own: an expiry is
            // worth nothing, and an exercise settles through its stock leg.
            disabled={isOptionLifecycleType(form.type)}
            placeholder={isOptionLifecycleType(form.type) ? "—" : "220.50"}
            className={`${INPUT} w-24 text-right disabled:opacity-40`}
          />
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Amount</span>
          <input
            value={form.amount}
            onChange={(e) => set({ amount: e.target.value })}
            placeholder="auto"
            title="Leave blank to compute from shares × price."
            className={`${INPUT} w-24 text-right`}
          />
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Fees</span>
          <input
            value={form.fees}
            onChange={(e) => set({ fees: e.target.value })}
            placeholder="0"
            className={`${INPUT} w-20 text-right`}
          />
        </label>
        {(opensLot || closesLot) && (
          <label className="text-[11.5px] text-dim-2">
            <span className="mb-0.5 block">Lot ID</span>
            <input
              value={form.lotId}
              onChange={(e) => set({ lotId: e.target.value })}
              placeholder="auto"
              title={lotHint}
              className={`${INPUT} w-44`}
            />
          </label>
        )}
        {opensLot && (
          <label className="text-[11.5px] text-dim-2">
            <span className="mb-0.5 block">Acquired</span>
            <input
              type="date"
              value={form.acquiredDate}
              onChange={(e) => set({ acquiredDate: e.target.value })}
              title="For transferred-in shares, the original purchase date that starts the holding period."
              className={INPUT}
            />
          </label>
        )}
        <div className="flex items-center gap-1.5">
          <Btn
            variant="primary"
            onClick={() => {
              if (!canSubmit) return;
              onSubmit(form);
              if (resetAfterSubmit) {
                setForm({ ...blankForm(form.accountId), date: form.date, type: form.type });
              }
            }}
            className={canSubmit ? "" : "pointer-events-none opacity-40"}
          >
            {submitLabel}
          </Btn>
          <Btn onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * The lot cell. A sale that drained several lots names all of them, which is
 * far too wide for a column, so only the first is shown with a count of the
 * rest -- the full list is in the tooltip. Clicking a lot searches for it,
 * which pulls the purchase and every sale that drew on it into one view.
 */
function LotCell({ tx, onSearch }: { tx: Transaction; onSearch: (query: string) => void }) {
  const ids = parseLotIds(tx.lotId);
  if (ids.length === 0) return <span className="text-dim-2">—</span>;
  return (
    <button
      type="button"
      onClick={() => onSearch(ids[0])}
      title={ids.length === 1 ? `Show everything in lot ${ids[0]}` : `Closes ${ids.join(", ")}`}
      className="text-left hover:text-foreground hover:underline"
    >
      {ids[0]}
      {ids.length > 1 && <span className="text-dim-2"> +{ids.length - 1}</span>}
    </button>
  );
}

/** Blank strings mean "use the computed default" for shares/price/fees, but an
 *  explicit zero (a $0 fee, a dividend's 0 shares) must survive as zero, not
 *  vanish into the same default. */
function num(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

export function TransactionsPanel({ portfolio }: { portfolio: Portfolio }) {
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const updateTransaction = usePortfolioStore((s) => s.updateTransaction);
  const removeTransaction = usePortfolioStore((s) => s.removeTransaction);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TransactionType | "all" | `group:${string}`>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [grouping, setGrouping] = useState<TxGrouping>("none");

  const accountNames = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, a.name])),
    [portfolio.accounts],
  );

  const accessors = useMemo<SortAccessors<Transaction, TxColumn>>(
    () => ({
      date: (tx) => tx.date,
      account: (tx) => accountNames.get(tx.accountId) ?? "",
      type: (tx) => TRANSACTION_TYPE_LABELS[tx.type],
      symbol: (tx) => tx.symbol ?? "",
      quantity: (tx) => signedQuantity(tx),
      price: (tx) => tx.price,
      amount: (tx) => signedTransactionAmount(tx),
      lot: (tx) => tx.lotId ?? "",
    }),
    [accountNames],
  );
  const { sort, toggle, apply } = useSort<Transaction, TxColumn>(accessors, "date");

  const filtered = useMemo(() => {
    const query = search.trim().toUpperCase();
    // A group selection matches every type in that group, so "Short" pulls both
    // the opening sale and the cover without needing two passes.
    const groupTypes =
      typeFilter.startsWith("group:")
        ? TRANSACTION_TYPE_GROUPS.find((g) => g.label === typeFilter.slice(6))?.types ?? []
        : null;

    return portfolio.transactions
      .filter((tx) => accountFilter === "all" || tx.accountId === accountFilter)
      // One box covers both symbol and lot id. Generated ids lead with the
      // symbol, so a plain "VTI" still finds every VTI row and a full id
      // narrows to the purchase and the sales that drew on it -- which is the
      // whole point of being able to search a lot at all.
      .filter(
        (tx) =>
          !query ||
          (tx.symbol ?? "").includes(query) ||
          (tx.lotId ?? "").toUpperCase().includes(query),
      )
      .filter((tx) =>
        typeFilter === "all" ? true : groupTypes ? groupTypes.includes(tx.type) : tx.type === typeFilter,
      )
      .filter((tx) => (!fromDate || tx.date >= fromDate) && (!toDate || tx.date <= toDate));
  }, [portfolio.transactions, accountFilter, search, typeFilter, fromDate, toDate]);

  const rows = useMemo(() => apply(filtered), [apply, filtered]);
  const filtersActive =
    accountFilter !== "all" || search !== "" || typeFilter !== "all" || fromDate !== "" || toDate !== "";

  const groups = useMemo(() => {
    if (grouping === "none") return [{ key: "", label: "", rows }];
    const labelFor = (tx: Transaction) =>
      grouping === "symbol"
        ? tx.symbol ?? "Cash & fees"
        : grouping === "account"
          ? accountNames.get(tx.accountId) ?? "Unknown account"
          : grouping === "type"
            ? TRANSACTION_TYPE_LABELS[tx.type]
            : tx.date.slice(0, 7);

    // Ranked by how much cash each group moved, in either direction: a group
    // that took $40k out is as worth surfacing as one that put $40k in.
    return buildGroups(rows, labelFor, (groupRows) =>
      groupRows.reduce((sum, tx) => sum + Math.abs(signedCashFlow(tx)), 0),
    );
  }, [rows, grouping, accountNames]);

  const collapse = useCollapsedGroups(grouping);
  const groupKeys = useMemo(() => groups.map((g) => g.key), [groups]);

  const defaultAccountId = accountFilter === "all" ? portfolio.accounts[0]?.id : accountFilter;

  return (
    <div className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-foreground">
          Transactions
          <span className="ml-2 text-[12px] font-normal text-dim-2">{rows.length} rows</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className={INPUT}
          >
            <option value="all">All accounts</option>
            {portfolio.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Symbol or lot ID"
            title="Matches a ticker or any part of a lot ID."
            className={`${INPUT} w-48`}
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className={INPUT}
          >
            <option value="all">All types</option>
            {TRANSACTION_TYPE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                <option value={`group:${group.label}`}>All {group.label.toLowerCase()}</option>
                {group.types.map((type) => (
                  <option key={type} value={type}>
                    {TRANSACTION_TYPE_LABELS[type]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
            From
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className={INPUT}
            />
          </label>
          <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
            To
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={INPUT} />
          </label>
          <Segmented
            options={TX_GROUPINGS}
            value={grouping}
            onChange={setGrouping}
            size="sm"
            ariaLabel="Group transactions"
          />
          {grouping !== "none" && <GroupToggles groupKeys={groupKeys} collapse={collapse} />}
          {filtersActive && (
            <Btn
              onClick={() => {
                setAccountFilter("all");
                setSearch("");
                setTypeFilter("all");
                setFromDate("");
                setToDate("");
              }}
            >
              Clear filters
            </Btn>
          )}
          {portfolio.accounts.length > 0 && (
            <Btn
              variant="primary"
              onClick={() => {
                setEditingId(null);
                setAdding((v) => !v);
              }}
            >
              {adding ? "Hide form" : "Add transaction"}
            </Btn>
          )}
        </div>
      </div>

      {adding && defaultAccountId && (
        <TransactionForm
          accounts={portfolio.accounts}
          initial={blankForm(defaultAccountId)}
          submitLabel="Add"
          resetAfterSubmit
          onCancel={() => setAdding(false)}
          onSubmit={(form) =>
            addTransaction({
              accountId: form.accountId,
              date: form.date,
              type: form.type,
              symbol: form.symbol.trim() ? normalizeSymbol(form.symbol) : null,
              quantity: num(form.quantity),
              price: num(form.price),
              amount: form.amount.trim() === "" ? null : num(form.amount),
              fees: num(form.fees),
              lotId: form.lotId.trim() || null,
              acquiredDate: form.acquiredDate || null,
              note: "",
              importBatchId: null,
              sourceHash: null,
            })
          }
        />
      )}

      {rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">
          No transactions yet. Import a statement or add one by hand.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div className="max-h-[70vh] overflow-auto rounded-md border border-border-soft">
          <table className="w-full border-collapse">
            <thead>
              <tr className="sticky top-0 z-10 border-b border-border bg-panel">
                <TxSortHeader label="Date" column="date" align="left" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Account" column="account" align="left" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Type" column="type" align="left" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Symbol" column="symbol" align="left" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Shares" column="quantity" align="right" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Price" column="price" align="right" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Amount" column="amount" align="right" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Lot" column="lot" align="left" sort={sort} onToggle={toggle} />
                <th className={`${HEAD} text-right`}></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const netCash = group.rows.reduce((sum, tx) => sum + signedCashFlow(tx), 0);
                const netQuantity = group.rows.reduce((sum, tx) => sum + signedQuantity(tx), 0);
                const collapsed = grouping !== "none" && collapse.isCollapsed(group.key);
                return (
                  <Fragment key={group.key || "all"}>
                    {grouping !== "none" && (
                      <GroupHeaderRow
                        label={group.label}
                        count={group.rows.length}
                        noun="row"
                        collapsed={collapsed}
                        onToggle={() => collapse.toggle(group.key)}
                        // Date, Account, Type, Symbol -- none of which totals
                        // across rows of different types.
                        labelSpan={4}
                        cells={[
                          <span
                            key="qty"
                            title="Net shares this group moved: buys less sells. Reconciles against the position's share count."
                          >
                            {shares(netQuantity)}
                          </span>,
                          null,
                          <span
                            key="net"
                            className={toneFor(netCash)}
                            title="Net cash this group moved: money in less money out."
                          >
                            {money(netCash)}
                          </span>,
                          null,
                          null,
                        ]}
                      />
                    )}
                    {!collapsed &&
                      group.rows.map((tx: Transaction) =>
                        editingId === tx.id ? (
                        <tr key={tx.id}>
                          <td colSpan={9} className="p-0">
                            <TransactionForm
                              accounts={portfolio.accounts}
                              initial={formFromTransaction(tx)}
                              submitLabel="Save"
                              onCancel={() => setEditingId(null)}
                              onSubmit={(form) => {
                                updateTransaction(tx.id, {
                                  accountId: form.accountId,
                                  date: form.date,
                                  type: form.type,
                                  symbol: form.symbol.trim() ? normalizeSymbol(form.symbol) : null,
                                  quantity: num(form.quantity),
                                  price: num(form.price),
                                  amount: form.amount.trim() === "" ? null : num(form.amount),
                                  fees: num(form.fees),
                                  lotId: form.lotId.trim() || null,
                                  acquiredDate: form.acquiredDate || null,
                                });
                                setEditingId(null);
                              }}
                            />
                          </td>
                        </tr>
                      ) : (
                        <tr key={tx.id} className="border-b border-border-soft hover:bg-panel-2">
                          <td className={`${CELL} text-left text-dim`}>{shortDate(tx.date)}</td>
                          <td className={`${CELL} text-left text-dim`}>
                            {accountNames.get(tx.accountId) ?? "—"}
                          </td>
                          <td className={`${CELL} text-left text-foreground`}>
                            {TRANSACTION_TYPE_LABELS[tx.type]}
                          </td>
                          <td
                            className={`${CELL} text-left font-semibold text-foreground`}
                            // A contract symbol is unreadable at a glance, so the
                            // statement wording is one hover away.
                            title={tx.symbol ? formatOptionSymbol(tx.symbol) : undefined}
                          >
                            {tx.symbol ?? "—"}
                          </td>
                          <td className={`${CELL} text-right text-dim`}>
                            {tx.quantity > 0 ? shares(signedQuantity(tx)) : "—"}
                          </td>
                          <td className={`${CELL} text-right text-dim`}>
                            {tx.price > 0 ? price(tx.price) : "—"}
                          </td>
                          <td className={`${CELL} text-right text-dim`}>{money(signedTransactionAmount(tx))}</td>
                          <td className={`${CELL} text-left text-dim-2`}>
                            <LotCell tx={tx} onSearch={setSearch} />
                          </td>
                          <td className={`${CELL} text-right`}>
                            <div className="flex items-center justify-end gap-2.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setAdding(false);
                                  setEditingId(tx.id);
                                }}
                                title="Edit this transaction"
                                className="text-dim-2 hover:text-foreground"
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                onClick={() => removeTransaction(tx.id)}
                                title="Delete this transaction"
                                className="text-dim-2 hover:text-negative"
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      ),
                      )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="sticky bottom-0 z-10 border-t border-border bg-panel font-semibold">
                <td className={`${CELL} text-left text-foreground`} colSpan={4}>
                  Total
                </td>
                {(() => {
                  const netQuantity = rows.reduce((sum, tx) => sum + signedQuantity(tx), 0);
                  return (
                    <td
                      className={`${CELL} text-right text-foreground`}
                      title="Net shares all rows moved: buys less sells. Reconciles against the position's share count."
                    >
                      {shares(netQuantity)}
                    </td>
                  );
                })()}
                <td className={CELL}></td>
                {(() => {
                  const netCash = rows.reduce((sum, tx) => sum + signedCashFlow(tx), 0);
                  return (
                    <td className={`${CELL} text-right ${toneFor(netCash)}`} title="Net cash all rows moved.">
                      {money(netCash)}
                    </td>
                  );
                })()}
                <td className={CELL}></td>
                <td className={CELL}></td>
              </tr>
            </tfoot>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
