"use client";

import { useState } from "react";
import type { Account, ExpenseBaseline, IncomeSource, Person } from "@/domain";
import { formatMoney } from "@/lib/format";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";

const FREQUENCY_LABELS: Record<string, string> = {
  monthly: "Monthly",
  biweekly: "Biweekly",
  weekly: "Weekly",
  annual: "Annual",
  one_time: "One time",
};

export function IncomeExpensesTable({
  incomeSources,
  expenses,
  accounts,
  people,
}: {
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  accounts: Account[];
  people: Person[];
}) {
  const [incomeDrawerOpen, setIncomeDrawerOpen] = useState(false);
  const [drawerIncome, setDrawerIncome] = useState<IncomeSource | undefined>(undefined);
  const [expenseDrawerOpen, setExpenseDrawerOpen] = useState(false);
  const [drawerExpense, setDrawerExpense] = useState<ExpenseBaseline | undefined>(undefined);

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const ownerName = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? "—" : "Joint");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Income</h3>
          <button
            type="button"
            onClick={() => {
              setDrawerIncome(undefined);
              setIncomeDrawerOpen(true);
            }}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
          >
            + Add Income
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-dim">
                <th className="py-2 pl-2 font-medium">Name</th>
                <th className="py-2 font-medium">Owner</th>
                <th className="py-2 text-right font-medium">Amount</th>
                <th className="py-2 font-medium">Frequency</th>
                <th className="py-2 pr-2 font-medium">Deposit Account</th>
              </tr>
            </thead>
            <tbody>
              {incomeSources.map((i) => (
                <tr
                  key={i.id}
                  className="cursor-pointer border-t border-border hover:bg-background/40"
                  onClick={() => {
                    setDrawerIncome(i);
                    setIncomeDrawerOpen(true);
                  }}
                >
                  <td className="py-1.5 pl-2">{i.name}</td>
                  <td className="py-1.5 text-dim">{ownerName(i.ownerId)}</td>
                  <td className="py-1.5 text-right">{formatMoney(i.amount)}</td>
                  <td className="py-1.5 text-dim">{FREQUENCY_LABELS[i.frequency]}</td>
                  <td className="py-1.5 pr-2 text-dim">{accountName(i.depositAccountId)}</td>
                </tr>
              ))}
              {incomeSources.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-dim">
                    No income sources yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Expenses</h3>
          <button
            type="button"
            onClick={() => {
              setDrawerExpense(undefined);
              setExpenseDrawerOpen(true);
            }}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
          >
            + Add Expense
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-dim">
                <th className="py-2 pl-2 font-medium">Name</th>
                <th className="py-2 text-right font-medium">Amount</th>
                <th className="py-2 font-medium">Frequency</th>
                <th className="py-2 pr-2 font-medium">Payment Account</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr
                  key={e.id}
                  className="cursor-pointer border-t border-border hover:bg-background/40"
                  onClick={() => {
                    setDrawerExpense(e);
                    setExpenseDrawerOpen(true);
                  }}
                >
                  <td className="py-1.5 pl-2">{e.name}</td>
                  <td className="py-1.5 text-right">{formatMoney(e.amount)}</td>
                  <td className="py-1.5 text-dim">{FREQUENCY_LABELS[e.frequency]}</td>
                  <td className="py-1.5 pr-2 text-dim">{accountName(e.paymentAccountId)}</td>
                </tr>
              ))}
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-dim">
                    No expenses yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <IncomeDrawer
        key={`income-${incomeDrawerOpen}-${drawerIncome?.id ?? "new"}`}
        open={incomeDrawerOpen}
        onClose={() => setIncomeDrawerOpen(false)}
        income={drawerIncome}
        people={people}
        accounts={accounts}
      />
      <ExpenseDrawer
        key={`expense-${expenseDrawerOpen}-${drawerExpense?.id ?? "new"}`}
        open={expenseDrawerOpen}
        onClose={() => setExpenseDrawerOpen(false)}
        expense={drawerExpense}
        accounts={accounts}
      />
    </div>
  );
}
