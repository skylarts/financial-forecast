"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ASSET_CLASS_LABELS,
  assetClassSchema,
  formatOptionSymbol,
  normalizeSymbol,
  type AssetClass,
  type PortfolioAccount,
  type TransactionType,
} from "@/domain/portfolio";
import { analyzePortfolio, type Holding, type PriceMap } from "@/engine/portfolio/metrics";
import type { ExpiredContract } from "@/engine/portfolio/expiredContracts";
import { usePortfolioStore, symbolsInPortfolio } from "@/store/usePortfolioStore";
import { usePlanStore } from "@/store/usePlanStore";
import { usePrices } from "@/store/usePriceStore";
import { useSecurityProfiles } from "@/store/useSecurityProfiles";
import { money, percent, shortDate, toneFor } from "@/lib/portfolio/format";
import type { ImportRow } from "@/lib/portfolio/importer";
import { toTransaction, type ProposedDividend } from "@/engine/portfolio/dividends";
import { Btn, Segmented } from "@/components/ui/controls";
import { ThemeSync } from "@/components/layout/ThemeToggle";
import { HoldingsTable, type HoldingGrouping } from "./HoldingsTable";
import { HoldingDetail } from "./HoldingDetail";
import { ImportDialog } from "./ImportDialog";
import { AccountsPanel } from "./AccountsPanel";
import { ExportMenu } from "./ExportMenu";
import { TransactionsPanel } from "./TransactionsPanel";
import { RealizedPanel } from "./RealizedPanel";
import { AllocationPanel, type AllocationDimension } from "./AllocationPanel";
import { BySymbolPanel } from "./BySymbolPanel";
import { PerformancePanel } from "./PerformancePanel";
import { DividendSyncDialog } from "./DividendSyncDialog";
import { PriceFeedNotice } from "./PriceFeedNotice";
import { ExpiredContractsNotice } from "./ExpiredContractsNotice";

const TABS = [
  { value: "holdings", label: "Holdings" },
  { value: "bySymbol", label: "By stock" },
  { value: "allocation", label: "Allocation" },
  { value: "performance", label: "Performance" },
  { value: "realized", label: "Realized" },
  { value: "transactions", label: "Transactions" },
  { value: "accounts", label: "Accounts" },
] as const;

type Tab = (typeof TABS)[number]["value"];

const GROUPINGS = [
  { value: "none", label: "None" },
  { value: "account", label: "By account" },
  { value: "assetClass", label: "By class" },
  { value: "side", label: "By side" },
] as const;

const SIDE_FILTERS = [
  { value: "all", label: "All" },
  { value: "long", label: "Long" },
  { value: "short", label: "Short" },
] as const;

type SideFilter = (typeof SIDE_FILTERS)[number]["value"];

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

export function PortfolioApp() {
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const hasHydrated = usePortfolioStore((s) => s.hasHydrated);
  const importTransactions = usePortfolioStore((s) => s.importTransactions);
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const addTransactions = usePortfolioStore((s) => s.addTransactions);
  const removeTransactions = usePortfolioStore((s) => s.removeTransactions);
  const upsertSecurity = usePortfolioStore((s) => s.upsertSecurity);
  const addAccount = usePortfolioStore((s) => s.addAccount);

  const scenario = usePlanStore((s) => s.activeScenario());
  const updateForecastAccount = usePlanStore((s) => s.updateAccount);

  const [tab, setTab] = useState<Tab>("holdings");
  const [scopeAccountId, setScopeAccountId] = useState<string>("all");
  const [selected, setSelected] = useState<Holding | null>(null);
  const [importing, setImporting] = useState(false);
  const [syncingDividends, setSyncingDividends] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [assetClassFilter, setAssetClassFilter] = useState<AssetClass | "all">("all");
  const [sideFilter, setSideFilter] = useState<SideFilter>("all");
  const [hideSmall, setHideSmall] = useState(false);
  const [grouping, setGrouping] = useState<HoldingGrouping>("none");

  const symbols = useMemo(() => symbolsInPortfolio(portfolio), [portfolio]);
  const {
    prices: liveQuotes,
    loading: pricesLoading,
    unknown: unknownSymbols,
    unavailable: unavailableSymbols,
    stale: liveStaleSymbols,
    refresh,
  } = usePrices(symbols);

  const securityBySymbol = useMemo(
    () => new Map(portfolio.securities.map((s) => [normalizeSymbol(s.symbol), s])),
    [portfolio.securities],
  );

  /**
   * Records every genuinely live quote onto its security, so a later request
   * that fails at a bad moment -- rate-limited, feed hiccup, whatever -- has a
   * real recent price to fall back on instead of leaving the row unpriced.
   * Session-cache fallbacks (already flagged `liveStaleSymbols`) don't
   * overwrite this: they're not a fresh answer from the feed.
   */
  useEffect(() => {
    for (const symbol of symbols) {
      if (liveStaleSymbols.includes(symbol)) continue;
      const quote = liveQuotes[symbol];
      if (!quote) continue;
      const security = securityBySymbol.get(symbol);
      if (security?.lastKnownPrice === quote.price && security.lastKnownPriceDate === quote.date) continue;
      upsertSecurity({
        symbol,
        name: security?.name ?? quote.name ?? "",
        assetClass: security?.assetClass ?? "other",
        assetClassSource: security?.assetClassSource ?? "auto",
        manualPrice: security?.manualPrice ?? null,
        manualPriceDate: security?.manualPriceDate ?? null,
        lastKnownPrice: quote.price,
        lastKnownPriceDate: quote.date,
      });
    }
    // Runs off the feed response, not the store snapshot -- re-keying on
    // securityBySymbol would refire this on the very writes it makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols, liveQuotes, liveStaleSymbols]);

  /**
   * Symbols the feed answered nothing for this session, but that have a
   * price on file from a previous successful fetch. Falls back the same way
   * the session cache does -- a day-old real number beats a blank "no
   * quote" cell -- except this survives a page reload or a cold server,
   * since it's read from the saved portfolio rather than in-memory cache.
   */
  const { prices, staleSymbols } = useMemo(() => {
    const merged: PriceMap = { ...liveQuotes };
    const recovered: string[] = [];
    for (const symbol of [...unknownSymbols, ...unavailableSymbols]) {
      const security = securityBySymbol.get(symbol);
      if (security?.manualPrice != null || security?.lastKnownPrice == null) continue;
      merged[symbol] = {
        price: security.lastKnownPrice,
        date: security.lastKnownPriceDate ?? "",
        name: security.name,
      };
      recovered.push(symbol);
    }
    return { prices: merged, staleSymbols: [...liveStaleSymbols, ...recovered] };
  }, [liveQuotes, liveStaleSymbols, unknownSymbols, unavailableSymbols, securityBySymbol]);

  // Recovered from a saved price, so they're no longer missing -- only a
  // genuinely unpriced symbol should still read as "no quote" in the banner.
  const displayUnknown = useMemo(
    () => unknownSymbols.filter((s) => !staleSymbols.includes(s)),
    [unknownSymbols, staleSymbols],
  );
  const displayUnavailable = useMemo(
    () => unavailableSymbols.filter((s) => !staleSymbols.includes(s)),
    [unavailableSymbols, staleSymbols],
  );

  const { profiles: securityProfiles, loading: classifying } = useSecurityProfiles(symbols);

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

  /**
   * Filters narrow which rows are listed, never how they're valued. Weights and
   * the summary tiles stay computed across the whole account scope, so hiding
   * small positions can't make the remaining ones look like a bigger share of
   * the portfolio than they are.
   */
  const visibleHoldings = useMemo(() => {
    const query = search.trim().toUpperCase();
    // "Small" is relative to the portfolio, not a fixed dollar figure: half a
    // percent is roughly where a position stops moving the needle at any size.
    const threshold = hideSmall ? 0.005 : 0;
    return analysis.holdings.filter((h) => {
      if (query && !h.symbol.includes(query) && !h.name.toUpperCase().includes(query)) return false;
      if (assetClassFilter !== "all" && h.assetClass !== assetClassFilter) return false;
      if (sideFilter !== "all" && h.side !== sideFilter) return false;
      if (Math.abs(h.weight) < threshold) return false;
      return true;
    });
  }, [analysis.holdings, search, assetClassFilter, sideFilter, hideSmall]);

  /** Only offer classes actually present, so the filter never lists dead ends. */
  const presentAssetClasses = useMemo(
    () => [...new Set(analysis.holdings.map((h) => h.assetClass))].sort(),
    [analysis.holdings],
  );
  const hasShorts = useMemo(() => analysis.holdings.some((h) => h.side === "short"), [analysis.holdings]);

  const securityFor = (symbol: string) =>
    portfolio.securities.find((s) => normalizeSymbol(s.symbol) === symbol);

  // Rendering before rehydration would flash an empty portfolio over real saved
  // data, which reads as data loss even though nothing was lost.
  if (!hasHydrated) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-dim">Loading…</div>;
  }

  const { summary } = analysis;

  const handleImport = (accountId: string, rows: ImportRow[]) => {
    // A statement dividend that lands on a payment the sync already wrote
    // under its ex-date supersedes that estimate rather than duplicating it.
    const replacedIds = rows
      .map((row) => row.syncMatchId)
      .filter((id): id is string => id !== null);
    const replaced = replacedIds.length > 0 ? removeTransactions(replacedIds) : 0;

    importTransactions(
      accountId,
      rows.map((row) => row.draft),
    );
    setImporting(false);
    setFlash(
      `Imported ${rows.length} transaction${rows.length === 1 ? "" : "s"}` +
        (replaced > 0 ? `, replacing ${replaced} synced dividend${replaced === 1 ? "" : "s"}.` : "."),
    );
  };

  /**
   * Records the event that closed an expired contract.
   *
   * Only the option leg is written. Exercise and assignment also move shares,
   * and inventing that trade would mean guessing a share count and a date the
   * statement already knows -- so the ledger's own warning names the trade to
   * add, and the flash says so up front rather than letting it look finished.
   */
  const handleRecordExpiry = (contract: ExpiredContract, type: TransactionType) => {
    addTransaction({
      accountId: contract.accountId,
      date: contract.expiry,
      type,
      symbol: contract.symbol,
      quantity: contract.quantity,
      price: 0,
      amount: null,
      fees: 0,
      lotId: null,
      acquiredDate: null,
      spinoffSymbol: null,
      spinoffShareRatio: null,
      spinoffBasisRetained: null,
      note: "",
      importBatchId: null,
      sourceHash: null,
    });

    setFlash(
      type === "option_expire"
        ? `Recorded ${formatOptionSymbol(contract.symbol)} as expired worthless.`
        : `Recorded ${formatOptionSymbol(contract.symbol)} as ${
            type === "option_assign" ? "assigned" : "exercised"
          }. Add the matching ${contract.underlying} trade at the ${
            contract.strike
          } strike so the premium lands in the share basis.`,
    );
  };

  /**
   * Takes a slice of the allocation ring through to the rows behind it.
   *
   * Each dimension lands on the filter that actually narrows to it, rather than
   * dropping the label into the search box and hoping it matches: an account
   * name isn't a ticker, and a class isn't either.
   */
  const handleDrillDown = (dimension: AllocationDimension, label: string) => {
    setTab("holdings");
    switch (dimension) {
      case "assetClass": {
        const match = assetClassSchema.options.find((cls) => ASSET_CLASS_LABELS[cls] === label);
        if (match) setAssetClassFilter(match);
        break;
      }
      case "account": {
        const match = portfolio.accounts.find((a) => a.name === label);
        if (match) setScopeAccountId(match.id);
        break;
      }
      case "accountType": {
        // No single-type scope exists, so this groups by account instead --
        // the rows land together, which is what the click was asking for.
        setGrouping("account");
        break;
      }
      case "symbol":
        setSearch(label);
        break;
      case "side":
        setSideFilter(label === "Short" ? "short" : "long");
        break;
    }
  };

  /**
   * Writes the dividends the user accepted.
   *
   * One store write rather than one per row: a first sync on a long-held
   * dividend payer can be a couple of hundred payments, and each write re-tidies
   * the whole ledger.
   */
  const handleApplyDividends = (proposals: ProposedDividend[]) => {
    const added = addTransactions(proposals.map(toTransaction));
    setSyncingDividends(false);
    setFlash(
      `Added ${added} dividend${added === 1 ? "" : "s"}. They're ordinary transactions now — edit or delete any of them.`,
    );
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
        <h1 className="text-[16px] font-semibold text-foreground">Portfolio</h1>
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
            onClick={() => setSyncingDividends(true)}
            title="Work out dividends from what you held on each ex-date"
          >
            Sync dividends
          </Btn>
          <ExportMenu portfolio={portfolio} />
          <Btn
            variant="primary"
            onClick={() => {
              if (portfolio.accounts.length === 0) {
                addAccount({
                  name: "Brokerage",
                  institution: "",
                  type: "taxable",
                  forecastAccountId: null,
                  openingCashBalance: 0,
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
              {analysis.warnings.length === 1
                ? "1 transaction needs a look"
                : `${analysis.warnings.length} transactions need a look`}
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

      <ExpiredContractsNotice
        contracts={analysis.expiredContracts}
        onRecord={handleRecordExpiry}
      />

      <PriceFeedNotice
        unknown={displayUnknown}
        unavailable={displayUnavailable}
        stale={staleSymbols}
        onRetry={refresh}
        retrying={pricesLoading}
      />

      <div className="border-b border-border px-6">
        <Segmented options={TABS} value={tab} onChange={setTab} size="sm" ariaLabel="Portfolio view" />
      </div>

      <main className="flex-1">
        {tab === "holdings" && (
          <div className="p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search symbol or name"
                className="w-52 rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
              />
              {presentAssetClasses.length > 1 && (
                <select
                  value={assetClassFilter}
                  onChange={(e) => setAssetClassFilter(e.target.value as AssetClass | "all")}
                  className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground"
                >
                  <option value="all">All asset classes</option>
                  {presentAssetClasses.map((cls) => (
                    <option key={cls} value={cls}>
                      {ASSET_CLASS_LABELS[cls]}
                    </option>
                  ))}
                </select>
              )}
              {hasShorts && (
                <Segmented
                  options={SIDE_FILTERS}
                  value={sideFilter}
                  onChange={setSideFilter}
                  size="sm"
                  ariaLabel="Filter by position side"
                />
              )}
              <select
                value={grouping}
                onChange={(e) => setGrouping(e.target.value as HoldingGrouping)}
                aria-label="Group holdings"
                className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground"
              >
                {GROUPINGS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-[12px] text-dim">
                <input
                  type="checkbox"
                  checked={hideSmall}
                  onChange={(e) => setHideSmall(e.target.checked)}
                />
                Hide under 0.5%
              </label>
              {visibleHoldings.length !== analysis.holdings.length && (
                <span className="text-[11.5px] text-dim-2">
                  Showing {visibleHoldings.length} of {analysis.holdings.length}
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setAssetClassFilter("all");
                      setSideFilter("all");
                      setHideSmall(false);
                    }}
                    className="ml-2 underline hover:text-foreground"
                  >
                    Clear filters
                  </button>
                </span>
              )}
            </div>
            <HoldingsTable
              holdings={visibleHoldings}
              accountNames={accountNames}
              showAccount={scopeAccountId === "all"}
              grouping={grouping}
              onSelect={setSelected}
            />
          </div>
        )}

        {tab === "bySymbol" && (
          <BySymbolPanel
            holdings={analysis.holdings}
            closedLots={analysis.closedLots}
            onSelectSymbol={(symbol) => {
              setSearch(symbol);
              setTab("holdings");
            }}
          />
        )}

        {tab === "allocation" && (
          <AllocationPanel
            holdings={analysis.holdings}
            accounts={portfolio.accounts}
            accountNames={accountNames}
            onDrillDown={handleDrillDown}
          >
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-[13px] font-semibold text-foreground">Classify holdings</h3>
                <span className="text-[11.5px] text-dim-2">
                  {classifying
                    ? "Reading classes from the feed…"
                    : "Classes come from the feed. Change one and your choice sticks."}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {/* Positions only -- cash is already a class, and offering to
                    reclassify it as an equity is an invitation to a wrong
                    allocation with no way to tell afterwards. */}
                {[
                  ...new Set(
                    analysis.holdings.filter((h) => h.kind === "position").map((h) => h.symbol),
                  ),
                ].map((symbol) => {
                  const security = securityFor(symbol);
                  // The feed's answer, if this session asked it. A holding
                  // classified on an earlier visit won't have one -- the hook
                  // skips re-asking about a symbol it already has a settled
                  // answer for -- so the badge below falls back to what's on
                  // the security record rather than requiring a fresh fetch.
                  const profile = securityProfiles[symbol];
                  const isManual = security?.assetClassSource === "manual";
                  const isAuto = security?.assetClassSource === "auto";
                  return (
                    <label
                      key={symbol}
                      title={formatOptionSymbol(symbol)}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2 py-1 text-[12px]"
                    >
                      <span className="font-semibold text-foreground">{symbol}</span>
                      <select
                        value={security?.assetClass ?? profile?.assetClass ?? "other"}
                        onChange={(e) =>
                          upsertSecurity({
                            symbol,
                            name: security?.name ?? profile?.name ?? "",
                            assetClass: e.target.value as AssetClass,
                            // Picking from this list is the disagreement that
                            // pins a class: nothing re-derives it afterwards.
                            assetClassSource: "manual",
                            manualPrice: security?.manualPrice ?? null,
                            manualPriceDate: security?.manualPriceDate ?? null,
                            lastKnownPrice: security?.lastKnownPrice ?? null,
                            lastKnownPriceDate: security?.lastKnownPriceDate ?? null,
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
                      {isManual ? (
                        <button
                          type="button"
                          onClick={() =>
                            profile
                              ? upsertSecurity({
                                  symbol,
                                  name: security?.name || profile.name,
                                  assetClass: profile.assetClass,
                                  assetClassSource: "auto",
                                  manualPrice: security?.manualPrice ?? null,
                                  manualPriceDate: security?.manualPriceDate ?? null,
                                  lastKnownPrice: security?.lastKnownPrice ?? null,
                                  lastKnownPriceDate: security?.lastKnownPriceDate ?? null,
                                })
                              : // No answer from this session to revert to --
                                // "other" is what an unclassified symbol reads
                                // as, so this hands it back to the feed to
                                // re-derive on the next check.
                                upsertSecurity({
                                  symbol,
                                  name: security?.name ?? "",
                                  assetClass: "other",
                                  assetClassSource: "auto",
                                  manualPrice: security?.manualPrice ?? null,
                                  manualPriceDate: security?.manualPriceDate ?? null,
                                  lastKnownPrice: security?.lastKnownPrice ?? null,
                                  lastKnownPriceDate: security?.lastKnownPriceDate ?? null,
                                })
                          }
                          title={
                            profile
                              ? `Go back to the feed's answer: ${
                                  ASSET_CLASS_LABELS[profile.assetClass]
                                }, ${profile.basis}.`
                              : "Go back to the feed's answer -- it'll be re-checked."
                          }
                          className="text-[11px] text-dim-2 hover:text-foreground"
                        >
                          ↺
                        </button>
                      ) : isAuto ? (
                        <span
                          title={
                            profile
                              ? `Read from the feed: ${profile.basis}.`
                              : "Read from the feed."
                          }
                          className="text-[10.5px] uppercase tracking-wide text-dim-2"
                        >
                          auto
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>
          </AllocationPanel>
        )}

        {tab === "performance" && (
          <PerformancePanel portfolio={portfolio} scopeAccountId={scopeAccountId} />
        )}

        {tab === "realized" && (
          <RealizedPanel
            closedLots={analysis.closedLots}
            summary={summary}
            accountNames={accountNames}
          />
        )}

        {tab === "transactions" && (
          <TransactionsPanel portfolio={portfolio} scopeAccountId={scopeAccountId} />
        )}

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

      {syncingDividends && (
        <DividendSyncDialog
          portfolio={portfolio}
          scopeAccountId={scopeAccountId}
          onClose={() => setSyncingDividends(false)}
          onApply={handleApplyDividends}
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
