"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { Account, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { useUiStore } from "@/store/useUiStore";

const CHART_COLORS = ["#5b8def", "#3ecf8e", "#e8555a", "#f4b740", "#a97bea", "#3ec7cf", "#f2789f", "#8fd14f"];
const PINK_CHART_COLORS = ["#ff4fa3", "#c874e8", "#ff8fab", "#f4a63b", "#8a6bea", "#3ec7cf", "#e8555a", "#5b8def"];

// Recharts needs concrete color strings, so mirror the two palettes here.
const CHART_THEME = {
  dark: { grid: "#2a3245", axis: "#9aa4b8", tooltipBg: "#171d2b", tooltipBorder: "#2a3245", label: "#e6e9f0" },
  pink: { grid: "#ffc9e0", axis: "#c06e93", tooltipBg: "#ffe4ef", tooltipBorder: "#ffbcda", label: "#6a2748" },
} as const;

type ViewMode = "net_worth" | "by_account";

export function nextHiddenAccountIds(
  hiddenAccountIds: Set<string>,
  accountIds: string[]
): Set<string> {
  const allHidden = accountIds.length > 0 && accountIds.every((id) => hiddenAccountIds.has(id));
  return allHidden ? new Set() : new Set(accountIds);
}

export function NetWorthChart({
  accounts: allAccounts,
  years,
  dollarMode,
  onDollarModeChange,
}: {
  accounts: Account[];
  years: YearSnapshot[];
  dollarMode: DollarMode;
  onDollarModeChange: (mode: DollarMode) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("net_worth");
  const [hiddenAccountIds, setHiddenAccountIds] = useState<Set<string>>(new Set());
  const isPink = useUiStore((s) => s.theme) === "pink";
  const theme = isPink ? CHART_THEME.pink : CHART_THEME.dark;
  const palette = isPink ? PINK_CHART_COLORS : CHART_COLORS;

  const accounts = useMemo(
    () => allAccounts.filter((a) => !a.isExcluded),
    [allAccounts]
  );

  const data = useMemo(() => {
    return years.map((y) => {
      const factor = dollarMode === "real" ? y.inflationDeflator : 1;
      const row: Record<string, number> = { year: y.year };
      if (viewMode === "net_worth") {
        row.value = (dollarMode === "real" ? y.netWorthReal : y.netWorthNominal);
      } else {
        for (const a of accounts) {
          const nominal = y.accountBalances[a.id] ?? 0;
          row[a.id] = nominal / factor;
        }
      }
      return row;
    });
  }, [years, viewMode, dollarMode, accounts]);

  const toggleAccount = (accountId: string) => {
    setHiddenAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };

  const allHidden = accounts.length > 0 && accounts.every((a) => hiddenAccountIds.has(a.id));

  const toggleAllAccounts = () => {
    setHiddenAccountIds((prev) => nextHiddenAccountIds(prev, accounts.map((a) => a.id)));
  };

  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-dim">
          {viewMode === "net_worth" ? "Net Worth Projection" : "Balance by Account"}
        </h2>
        <div className="flex items-center gap-2">
          {viewMode === "by_account" && (
            <button
              type="button"
              onClick={toggleAllAccounts}
              className="rounded-md border border-border px-2 py-1 text-xs text-dim"
            >
              {allHidden ? "Show all" : "Hide all"}
            </button>
          )}
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("net_worth")}
              className={`rounded px-2 py-1 text-xs ${viewMode === "net_worth" ? "bg-accent text-white" : "text-dim"}`}
            >
              Net Worth
            </button>
            <button
              type="button"
              onClick={() => setViewMode("by_account")}
              className={`rounded px-2 py-1 text-xs ${viewMode === "by_account" ? "bg-accent text-white" : "text-dim"}`}
            >
              By Account
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => onDollarModeChange("nominal")}
              className={`rounded px-2 py-1 text-xs ${dollarMode === "nominal" ? "bg-accent text-white" : "text-dim"}`}
            >
              Nominal
            </button>
            <button
              type="button"
              onClick={() => onDollarModeChange("real")}
              className={`rounded px-2 py-1 text-xs ${dollarMode === "real" ? "bg-accent text-white" : "text-dim"}`}
            >
              Real
            </button>
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
          <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
          <XAxis dataKey="year" stroke={theme.axis} tick={{ fontSize: 12 }} />
          <YAxis stroke={theme.axis} tick={{ fontSize: 12 }} tickFormatter={(v) => formatMoney(v)} width={80} />
          <Tooltip
            contentStyle={{ background: theme.tooltipBg, border: `1px solid ${theme.tooltipBorder}`, borderRadius: 8 }}
            labelStyle={{ color: theme.label }}
            formatter={(value, name) => [
              formatMoney(Number(value)),
              viewMode === "net_worth" ? "Net Worth" : accounts.find((a) => a.id === name)?.name ?? String(name),
            ]}
          />
          <Legend
            onClick={(e) => {
              if (viewMode === "by_account" && typeof e.dataKey === "string") toggleAccount(e.dataKey);
            }}
            formatter={(value: string) =>
              viewMode === "net_worth" ? "Net Worth" : accounts.find((a) => a.id === value)?.name ?? value
            }
            wrapperStyle={{ fontSize: 12, cursor: viewMode === "by_account" ? "pointer" : "default" }}
          />
          {viewMode === "net_worth" ? (
            <Line type="monotone" dataKey="value" stroke={palette[0]} dot={false} strokeWidth={2} />
          ) : (
            accounts.map((a, i) => (
              <Line
                key={a.id}
                type="monotone"
                dataKey={a.id}
                stroke={palette[i % palette.length]}
                dot={false}
                strokeWidth={2}
                hide={hiddenAccountIds.has(a.id)}
              />
            ))
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
