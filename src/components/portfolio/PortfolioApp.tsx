"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ASSET_CLASS_LABELS,
  assetClassSchema,
  normalizeSymbol,
  type AssetClass,
  type PortfolioAccount,
} from "@/domain/portfolio";
import { analyzePortfolio, type Holding } from "@/engine/portfolio/metrics";
import { usePortfolioStore, symbolsInPortfolio } from "@/store/usePortfolioStore";
import { usePlanStore } from "@/store/usePlanStore";
import { usePrices } from "@/store/usePriceStore";
import { money, percent, shortDate, toneFor } from "@/lib/portfolio/format";
import type { ImportRow } from "@/lib/portfolio/importer";
import { Btn, Segmented } from "@/components/ui/controls";
import { ThemeSync } from "@/components/layout/ThemeToggle";
import { HoldingsTable } from "./HoldingsTable";
import { HoldingDetail } from "./HoldingDetail";
import { ImportDialog } from "./ImportDialog";
import { AccountsPanel } from "./AccountsPanel";
import { TransactionsPanel } from "./TransactionsPanel";

const TABS = [
  { value: "holdings", label: "Holdings" },
  { value: "allocation", label: "Allocation" },
  { value: "realized", label: "Realized" },
  { value: "transactions", label: "Transactions" },
  { value: "accounts", label: "Accounts" },
] as const;

type Tab = (typeof TABS)[number]["value"];

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3" title={hint}>
      <div className="text-[10.5px] uppercase tracking-wide text-dim-2">{label}</div>
      <div className={`mt-1 text-[19px] font-semibold tabular-nums ${tone || "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

function AllocationBars({
  title,
  slices,
}: {
  title: string;
  slices: { label: string; value: number; weight: number }[];
}) {
  return (
    <div>
      <h3 className="mb-2 text-[13px] font-semibold text-foreground">{title}</h3>
      {slices.length === 0 ? (
        <p className="text-[12.5px] text-dim">Nothing to show yet.</p>
      ) : (
        <div className="space-y-1.5">
          {slices.map((slice) => (
            <div key={slice.label} className="flex items-center gap-3">
              <div className="w-40 shrink-0 truncate text-[12px] text-dim">{slice.label}</div>
              <div className="h-3 flex-1 overflow-hidden rounded-sm bg-panel-2">
                <div
                  className="h-full rounded-sm bg-accent"
                  style={{ width: `${Math.max(slice.weight * 100, 0.5)}%` }}
                />
              </div>
              <div className="w-16 shrink-0 text-right text-[12px] tabular-nums text-dim">
                {(slice.weight * 100).toFixed(1)}%
              </div>
              <div className="w-24 shrink-0 text-right text-[12px] tabular-nums text-foreground">
                {money(slice.value)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PortfolioApp() {
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const hasHydrated = usePortfolioStore((s) => s.hasHydrated);
  const importTransactions = usePortfolioStore((s) => s.importTransactions);
  const upsertSecurity = usePortfolioStore((s) => s.upsertSecurity);
  const addAccount = usePortfolioStore((s) => s.addAccount);

  const scenario = usePlanStore((s) => s.activeScenario());
  const updateForecastAccount = usePlanStore((s) => s.updateAccount);

  const [tab, setTab] = useState<Tab>("holdings");
  const [scopeAccountId, setScopeAccountId] = useState<string>("all");
  const [selected, setSelected] = useState<Holding | null>(null);
  const [importing, setImporting] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const symbols = useMemo(() => symbolsInPortfolio(portfolio), [portfolio]);
  const { prices, loading: pricesLoading, refresh } = usePrices(symbols);

  const analysis = useMemo(
    () =>
      analyzePortfolio(portfolio, prices, {
        accountIds: scopeAccountId === "all" ? undefined : [scopeAccountId],
      }),
    [portfolio, prices, scopeAccountId],
  );

  const accountNames = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, a.name])),
    [portfolio.accounts],
  );

  const securityFor = (symbol: string) =>
    portfolio.securities.find((s) => normalizeSymbol(s.symbol) === symbol);

  // Rendering before rehydration would flash an empty portfolio over real saved
  // data, which reads as data loss even though nothing was lost.
  if (!hasHydrated) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-dim">Loading…</div>;
  }

  const { summary } = analysis;

  const handleImport = (accountId: string, rows: ImportRow[]) => {
    importTransactions(
      accountId,
      rows.map((row) => row.draft),
    );
    setImporting(false);
    setFlash(`Imported ${rows.length} transaction${rows.length === 1 ? "" : "s"}.`);
  };

  const handlePush = (account: PortfolioAccount, value: number, costBasis: number) => {
    const target = scenario.accounts.find((a) => a.id === account.forecastAccountId);
    if (!target) return;
    updateForecastAccount(target.id, {
      ...target,
      startingBalance: Math.round(value),
      // Basis only means anything on a taxable account; sending it elsewhere
      // would put a number the engine ignores into the plan file.
      ...(target.taxTreatment === "taxable" ? { startingCostBasis: Math.round(costBasis) } : {}),
    });
    setFlash(`Pushed ${money(value)} into "${target.name}" in the forecast.`);
  };

  return (
    <>
      <ThemeSync />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-panel px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-[16px] font-semibold text-foreground">Portfolio</h1>
          <Link
            href="/"
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-dim transition-colors hover:border-accent hover:text-foreground"
          >
            ← Forecast
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={scopeAccountId}
            onChange={(e) => setScopeAccountId(e.target.value)}
            className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground"
          >
            <option value="all">All accounts</option>
            {portfolio.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <Btn onClick={refresh} title="Refetch quotes now">
            {pricesLoading ? "Refreshing…" : "Refresh prices"}
          </Btn>
          <Btn
            variant="primary"
            onClick={() => {
              if (portfolio.accounts.length === 0) {
                addAccount({
                  name: "Brokerage",
                  institution: "",
                  type: "taxable",
                  forecastAccountId: null,
                  cashBalance: 0,
                });
              }
              setImporting(true);
            }}
          >
            Import transactions
          </Btn>
        </div>
      </header>

      {flash && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-panel-2 px-6 py-2 text-[12.5px] text-foreground">
          <span>{flash}</span>
          <button type="button" onClick={() => setFlash(null)} className="text-dim hover:text-foreground">
            Dismiss
          </button>
        </div>
      )}

      {analysis.warnings.length > 0 && (
        <div className="border-b border-border bg-panel-2 px-6 py-2">
          <details>
            <summary className="cursor-pointer text-[12.5px] text-accent">
              {analysis.warnings.length} transaction
              {analysis.warnings.length === 1 ? "" : "s"} need a look
            </summary>
            <ul className="mt-1.5 space-y-1">
              {analysis.warnings.map((warning, i) => (
                <li key={i} className="text-[12px] text-dim">
                  {shortDate(warning.date)} · {warning.symbol} — {warning.message}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 px-6 py-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total value" value={money(summary.totalValue)} hint="Positions plus uninvested cash." />
        <Stat label="Cost basis" value={money(summary.costBasis)} />
        <Stat
          label="Unrealized"
          value={money(summary.unrealizedGain)}
          tone={toneFor(summary.unrealizedGain)}
        />
        <Stat
          label="Return"
          value={percent(summary.unrealizedGainPct)}
          tone={toneFor(summary.unrealizedGain)}
        />
        <Stat
          label="Realized"
          value={money(summary.realizedGain)}
          tone={toneFor(summary.realizedGain)}
          hint="All-time realized gains from closed lots."
        />
        <Stat
          label="Annualized"
          value={percent(summary.irr)}
          tone={toneFor(summary.irr ?? 0)}
          hint="Money-weighted return across every trade and dividend in scope."
        />
      </div>

      <div className="border-b border-border px-6">
        <Segmented options={TABS} value={tab} onChange={setTab} size="sm" ariaLabel="Portfolio view" />
      </div>

      <main className="flex-1">
        {tab === "holdings" && (
          <div className="p-5">
            <HoldingsTable
              holdings={analysis.holdings}
              accountNames={accountNames}
              showAccount={scopeAccountId === "all"}
              onSelect={setSelected}
            />
          </div>
        )}

        {tab === "allocation" && (
          <div className="space-y-6 p-5">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-foreground">By asset class</h3>
                <span className="text-[11.5px] text-dim-2">
                  Set a symbol&apos;s class below to group it.
                </span>
              </div>
              <AllocationBars
                title=""
                slices={analysis.byAssetClass.map((s) => ({
                  ...s,
                  label: ASSET_CLASS_LABELS[s.label as AssetClass] ?? s.label,
                }))}
              />
            </div>
            <AllocationBars title="By account" slices={analysis.byAccount} />
            <AllocationBars title="By holding" slices={analysis.bySymbol} />

            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-foreground">Classify holdings</h3>
              <div className="flex flex-wrap gap-2">
                {[...new Set(analysis.holdings.map((h) => h.symbol))].map((symbol) => {
                  const security = securityFor(symbol);
                  return (
                    <label
                      key={symbol}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2 py-1 text-[12px]"
                    >
                      <span className="font-semibold text-foreground">{symbol}</span>
                      <select
                        value={security?.assetClass ?? "other"}
                        onChange={(e) =>
                          upsertSecurity({
                            symbol,
                            name: security?.name ?? "",
                            assetClass: e.target.value as AssetClass,
                            manualPrice: security?.manualPrice ?? null,
                            manualPriceDate: security?.manualPriceDate ?? null,
                          })
                        }
                        className="rounded border border-border bg-panel px-1.5 py-0.5 text-[11.5px] text-foreground"
                      >
                        {assetClassSchema.options.map((cls) => (
                          <option key={cls} value={cls}>
                            {ASSET_CLASS_LABELS[cls]}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {tab === "realized" && (
          <div className="p-5">
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Realized YTD" value={money(summary.realizedGainYtd)} tone={toneFor(summary.realizedGainYtd)} />
              <Stat label="Short-term" value={money(summary.realizedShortTerm)} tone={toneFor(summary.realizedShortTerm)} />
              <Stat label="Long-term" value={money(summary.realizedLongTerm)} tone={toneFor(summary.realizedLongTerm)} />
              <Stat label="Dividends & interest" value={money(summary.income)} />
            </div>
            {analysis.closedLots.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-dim">
                No closed positions yet. Sells will show up here with their tax lots matched.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      {["Symbol", "Account", "Acquired", "Sold", "Shares", "Cost basis", "Proceeds", "Gain", "Term"].map(
                        (h, i) => (
                          <th
                            key={h}
                            className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2 ${
                              i >= 4 ? "text-right" : "text-left"
                            }`}
                          >
                            {h}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.closedLots.map((lot, i) => (
                      <tr key={`${lot.closeTxId}-${i}`} className="border-b border-border-soft">
                        <td className="px-3 py-2 text-[12.5px] font-semibold text-foreground">{lot.symbol}</td>
                        <td className="px-3 py-2 text-[12.5px] text-dim">
                          {accountNames.get(lot.accountId) ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-[12.5px] text-dim">{shortDate(lot.acquiredDate)}</td>
                        <td className="px-3 py-2 text-[12.5px] text-dim">{shortDate(lot.disposedDate)}</td>
                        <td className="px-3 py-2 text-right text-[12.5px] tabular-nums text-dim">
                          {lot.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </td>
                        <td className="px-3 py-2 text-right text-[12.5px] tabular-nums text-dim">
                          {money(lot.costBasis)}
                        </td>
                        <td className="px-3 py-2 text-right text-[12.5px] tabular-nums text-dim">
                          {money(lot.proceeds)}
                        </td>
                        <td className={`px-3 py-2 text-right text-[12.5px] tabular-nums ${toneFor(lot.gain)}`}>
                          {money(lot.gain)}
                        </td>
                        <td className="px-3 py-2 text-right text-[12.5px] text-dim">
                          {lot.taxable ? (lot.term === "long" ? "Long" : "Short") : "Transfer"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "transactions" && <TransactionsPanel portfolio={portfolio} />}

        {tab === "accounts" && (
          <AccountsPanel
            portfolio={portfolio}
            prices={prices}
            forecastAccounts={scenario.accounts}
            onPush={handlePush}
          />
        )}
      </main>

      {selected && (
        <HoldingDetail
          holding={selected}
          transactions={portfolio.transactions
            .filter(
              (tx) =>
                tx.accountId === selected.accountId &&
                tx.symbol !== null &&
                normalizeSymbol(tx.symbol) === selected.symbol,
            )
            .sort((a, b) => (a.date < b.date ? 1 : -1))}
          closedLots={analysis.closedLots.filter(
            (lot) => lot.accountId === selected.accountId && lot.symbol === selected.symbol,
          )}
          onClose={() => setSelected(null)}
        />
      )}

      {importing && (
        <ImportDialog
          accounts={portfolio.accounts}
          existingTransactions={portfolio.transactions}
          onImport={handleImport}
          onClose={() => setImporting(false)}
        />
      )}
    </>
  );
}
