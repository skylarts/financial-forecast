"use client";

import { useMemo, useState } from "react";
import {
  opensLotOn,
  normalizeSymbol,
  TRANSACTION_TYPE_GROUPS,
  TRANSACTION_TYPE_LABELS,
  type Portfolio,
  type Transaction,
  type TransactionType,
} from "@/domain/portfolio";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { money, price, shares, shortDate } from "@/lib/portfolio/format";
import { Btn } from "@/components/ui/controls";
import { sortMarker, useSort, type SortAccessors } from "./useSort";

const INPUT =
  "rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent";
const HEAD = "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

type TxColumn = "date" | "account" | "type" | "symbol" | "quantity" | "price" | "amount";

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

const BLANK = {
  date: new Date().toISOString().slice(0, 10),
  type: "buy" as TransactionType,
  symbol: "",
  quantity: "",
  price: "",
  amount: "",
  fees: "",
  lotId: "",
  acquiredDate: "",
};

function AddTransactionForm({
  accountId,
  onDone,
}: {
  accountId: string;
  onDone: () => void;
}) {
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const [form, setForm] = useState(BLANK);

  const set = (patch: Partial<typeof BLANK>) => setForm((f) => ({ ...f, ...patch }));
  const num = (raw: string) => {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? Math.abs(value) : 0;
  };

  const needsSymbol = form.type !== "cash_deposit" && form.type !== "cash_withdrawal" && form.type !== "interest" && form.type !== "fee";
  const canSubmit = form.date !== "" && (!needsSymbol || form.symbol.trim() !== "");
  const opensLot = opensLotOn(form.type) !== null;

  return (
    <div className="mb-4 rounded-md border border-border bg-panel-2 p-3">
      <div className="flex flex-wrap items-end gap-2">
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
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Symbol</span>
          <input
            value={form.symbol}
            onChange={(e) => set({ symbol: e.target.value })}
            placeholder="VTI"
            className={`${INPUT} w-24`}
          />
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">{form.type === "split" ? "Ratio" : "Shares"}</span>
          <input
            value={form.quantity}
            onChange={(e) => set({ quantity: e.target.value })}
            placeholder={form.type === "split" ? "2" : "10"}
            className={`${INPUT} w-24 text-right`}
          />
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Price</span>
          <input
            value={form.price}
            onChange={(e) => set({ price: e.target.value })}
            placeholder="220.50"
            className={`${INPUT} w-24 text-right`}
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
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Lot ID</span>
          <input
            value={form.lotId}
            onChange={(e) => set({ lotId: e.target.value })}
            placeholder="optional"
            title="On a sell, names the exact lot being closed instead of using oldest-first."
            className={`${INPUT} w-28`}
          />
        </label>
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
              addTransaction({
                accountId,
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
              });
              setForm({ ...BLANK, date: form.date, type: form.type });
            }}
            className={canSubmit ? "" : "pointer-events-none opacity-40"}
          >
            Add
          </Btn>
          <Btn onClick={onDone}>Done</Btn>
        </div>
      </div>
    </div>
  );
}

export function TransactionsPanel({ portfolio }: { portfolio: Portfolio }) {
  const removeTransaction = usePortfolioStore((s) => s.removeTransaction);
  const [adding, setAdding] = useState(false);
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [symbolFilter, setSymbolFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<TransactionType | "all" | `group:${string}`>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

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
      quantity: (tx) => tx.quantity,
      price: (tx) => tx.price,
      amount: (tx) => tx.amount ?? tx.quantity * tx.price,
    }),
    [accountNames],
  );
  const { sort, toggle, apply } = useSort<Transaction, TxColumn>(accessors, "date");

  const filtered = useMemo(() => {
    const query = symbolFilter.trim().toUpperCase();
    // A group selection matches every type in that group, so "Short" pulls both
    // the opening sale and the cover without needing two passes.
    const groupTypes =
      typeFilter.startsWith("group:")
        ? TRANSACTION_TYPE_GROUPS.find((g) => g.label === typeFilter.slice(6))?.types ?? []
        : null;

    return portfolio.transactions
      .filter((tx) => accountFilter === "all" || tx.accountId === accountFilter)
      .filter((tx) => !query || (tx.symbol ?? "").includes(query))
      .filter((tx) =>
        typeFilter === "all" ? true : groupTypes ? groupTypes.includes(tx.type) : tx.type === typeFilter,
      )
      .filter((tx) => (!fromDate || tx.date >= fromDate) && (!toDate || tx.date <= toDate));
  }, [portfolio.transactions, accountFilter, symbolFilter, typeFilter, fromDate, toDate]);

  const rows = useMemo(() => apply(filtered), [apply, filtered]);
  const filtersActive =
    accountFilter !== "all" || symbolFilter !== "" || typeFilter !== "all" || fromDate !== "" || toDate !== "";

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
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
            placeholder="Filter by symbol"
            className={`${INPUT} w-40`}
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
          {filtersActive && (
            <Btn
              onClick={() => {
                setAccountFilter("all");
                setSymbolFilter("");
                setTypeFilter("all");
                setFromDate("");
                setToDate("");
              }}
            >
              Clear filters
            </Btn>
          )}
          {portfolio.accounts.length > 0 && (
            <Btn variant="primary" onClick={() => setAdding((v) => !v)}>
              {adding ? "Hide form" : "Add transaction"}
            </Btn>
          )}
        </div>
      </div>

      {adding && defaultAccountId && (
        <AddTransactionForm accountId={defaultAccountId} onDone={() => setAdding(false)} />
      )}

      {rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">
          No transactions yet. Import a statement or add one by hand.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <TxSortHeader label="Date" column="date" align="left" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Account" column="account" align="left" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Type" column="type" align="left" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Symbol" column="symbol" align="left" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Shares" column="quantity" align="right" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Price" column="price" align="right" sort={sort} onToggle={toggle} />
                <TxSortHeader label="Amount" column="amount" align="right" sort={sort} onToggle={toggle} />
                <th className={`${HEAD} text-left`}>Lot</th>
                <th className={`${HEAD} text-right`}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tx: Transaction) => (
                <tr key={tx.id} className="border-b border-border-soft hover:bg-panel-2">
                  <td className={`${CELL} text-left text-dim`}>{shortDate(tx.date)}</td>
                  <td className={`${CELL} text-left text-dim`}>
                    {accountNames.get(tx.accountId) ?? "—"}
                  </td>
                  <td className={`${CELL} text-left text-foreground`}>
                    {TRANSACTION_TYPE_LABELS[tx.type]}
                  </td>
                  <td className={`${CELL} text-left font-semibold text-foreground`}>
                    {tx.symbol ?? "—"}
                  </td>
                  <td className={`${CELL} text-right text-dim`}>
                    {tx.quantity > 0 ? shares(tx.quantity) : "—"}
                  </td>
                  <td className={`${CELL} text-right text-dim`}>
                    {tx.price > 0 ? price(tx.price) : "—"}
                  </td>
                  <td className={`${CELL} text-right text-dim`}>
                    {tx.amount === null ? money(tx.quantity * tx.price) : money(tx.amount)}
                  </td>
                  <td className={`${CELL} text-left text-dim-2`}>{tx.lotId ?? "—"}</td>
                  <td className={`${CELL} text-right`}>
                    <button
                      type="button"
                      onClick={() => removeTransaction(tx.id)}
                      title="Delete this transaction"
                      className="text-dim-2 hover:text-negative"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
