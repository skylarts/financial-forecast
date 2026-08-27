"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  allThemes,
  formatOptionSymbol,
  normalizeSymbol,
  type PortfolioAccount,
  type TransactionType,
} from "@/domain/portfolio";
import { analyzePortfolio, type Holding, type PriceMap } from "@/engine/portfolio/metrics";
import { SecurityEditorRow } from "./SecurityEditor";
import { SummaryCards } from "./SummaryCards";
import type { ExpiredContract } from "@/engine/portfolio/expiredContracts";
import { usePortfolioStore, symbolsInPortfolio } from "@/store/usePortfolioStore";
import { usePortfolioCloudSync } from "@/store/usePortfolioCloudSync";
import { useCloudSync } from "@/store/useCloudSync";
import { useForecastValueSync } from "@/store/useForecastValueSync";
import { AccountTopMenuItem, SignOutMenuItem } from "@/components/auth/LoginButton";
import { usePlanStore } from "@/store/usePlanStore";
import { usePrices } from "@/store/usePriceStore";
import { useSecurityProfiles } from "@/store/useSecurityProfiles";
import { money, shortDate } from "@/lib/portfolio/format";
import {
  accountIdsInScope,
  accountScope,
  ALL_ACCOUNTS_SCOPE,
  JOINT_OWNER_SCOPE,
  ownerScope,
} from "@/lib/portfolio/scope";
import type { ImportRow } from "@/lib/portfolio/importer";
import { buildDemoPortfolio } from "@/lib/portfolio/demoPortfolio";
import { Btn, Segmented } from "@/components/ui/controls";
import { ThemeSync } from "@/components/layout/ThemeToggle";
import { HoldingsTable, type HoldingGrouping } from "./HoldingsTable";
import { useCollapsedGroups } from "./grouping";
import { HoldingDetail } from "./HoldingDetail";
import { ImportDialog } from "./ImportDialog";
import { AccountsPanel } from "./AccountsPanel";
import { ExportMenu } from "./ExportMenu";
import { TransactionsPanel } from "./TransactionsPanel";
import { RealizedPanel } from "./RealizedPanel";
import type { AllocationDimension } from "./AllocationPanel";
import { BySymbolPanel } from "./BySymbolPanel";
import { PriceFeedNotice } from "./PriceFeedNotice";
import { ExpiredContractsNotice } from "./ExpiredContractsNotice";
import { FilterStatus } from "./FilterStatus";
import { FacetMenu } from "@/components/ui/FacetMenu";
import {
  assetClassFacetOptions,
  emptyHoldingFacets,
  holdingFacetsActive,
  instrumentTypeFacetOptions,
  matchesHoldingFacets,
  themeFacetOptions,
  type HoldingFacets,
} from "./filters";
import { useMarketIndexStore } from "@/store/useMarketIndexes";

/**
 * Both panels pull in Recharts, and only one tab is ever showing at a time --
 * loading it into the bundle every other tab has to download too would be
 * paying for a chart nobody asked to see yet. Split out here instead, so
 * visiting Holdings for the first time never touches this code at all.
 */
const AllocationPanel = dynamic(
  () => import("./AllocationPanel").then((m) => m.AllocationPanel),
  { ssr: false, loading: () => <TabSkeleton /> },
);
const PerformancePanel = dynamic(
  () => import("./PerformancePanel").then((m) => m.PerformancePanel),
  { ssr: false, loading: () => <TabSkeleton /> },
);

function TabSkeleton() {
  return <div className="m-5 h-[400px] animate-pulse rounded-md bg-panel-2" />;
}

const TABS = [
  { value: "holdings", label: "Holdings" },
  { value: "allocation", label: "Allocation" },
  { value: "performance", label: "Performance" },
  { value: "realized", label: "Realized" },
  { value: "transactions", label: "Transactions" },
  { value: "accounts", label: "Accounts" },
] as const;

type Tab = (typeof TABS)[number]["value"];

/**
 * Performance splits two ways over the same question -- how the whole
 * portfolio moved through time, and which names drove it. They used to be
 * separate tabs, which made comparing them a trip across the tab bar; the
 * switch below keeps both a click apart inside one tab.
 */
const PERFORMANCE_VIEWS = [
  { value: "overTime", label: "Over time" },
  { value: "bySymbol", label: "By stock" },
] as const;

type PerformanceView = (typeof PERFORMANCE_VIEWS)[number]["value"];

const SIDE_FILTERS = [
  { value: "all", label: "All" },
  { value: "long", label: "Long" },
  { value: "short", label: "Short" },
] as const;

type SideFilter = (typeof SIDE_FILTERS)[number]["value"];

// Same sign-in-with-Google affordance the forecast tool's header exposes,
// so a household can sync the portfolio to the same account without ever
// leaving this page -- reuses the same auth state, just without the
// forecast-specific menu items (Setup Guide, backup controls) that don't
// apply here.
function AccountMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Account"
        className="rounded-md border border-border bg-panel-2 px-2.5 py-1.5 text-sm text-dim hover:text-foreground"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-border bg-panel p-1 shadow-lg">
          <AccountTopMenuItem onClose={() => setOpen(false)} />
          <div className="border-t border-border pt-1">
            <SignOutMenuItem onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

export function PortfolioApp() {
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const hasHydrated = usePortfolioStore((s) => s.hasHydrated);
  const importTransactions = usePortfolioStore((s) => s.importTransactions);
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const removeTransactions = usePortfolioStore((s) => s.removeTransactions);
  const upsertSecurity = usePortfolioStore((s) => s.upsertSecurity);
  const addAccount = usePortfolioStore((s) => s.addAccount);
  const loadPortfolio = usePortfolioStore((s) => s.loadPortfolio);
  usePortfolioCloudSync();
  // Mounted here too, not just on the forecast's own page (src/app/page.tsx) --
  // otherwise a plan edit made from this page (the auto-sync below, or the
  // manual "Push to forecast" button) never reaches Supabase, and the next
  // visit to "/" pulls the cloud plan over it and silently discards it.
  const { cloudSyncReady } = useCloudSync();

  const scenario = usePlanStore((s) => s.activeScenario());
  const updateForecastAccount = usePlanStore((s) => s.updateAccount);
  const people = scenario.household.people;

  const [tab, setTab] = useState<Tab>("holdings");
  const [performanceView, setPerformanceView] = useState<PerformanceView>("overTime");
  const [scope, setScope] = useState<string>(ALL_ACCOUNTS_SCOPE);
  const [selected, setSelected] = useState<Holding | null>(null);
  const [importing, setImporting] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Search and the three facets are shared by every tab that can read them,
  // rather than re-declared on each. They used to be four search boxes and
  // three facet sets with seven independent memories, so narrowing to Crypto
  // on Allocation and moving to Performance meant picking Crypto again.
  const [search, setSearch] = useState("");
  const [facets, setFacets] = useState<HoldingFacets>(emptyHoldingFacets());
  const [sideFilter, setSideFilter] = useState<SideFilter>("all");
  const [grouping, setGrouping] = useState<HoldingGrouping>("none");
  const holdingCollapse = useCollapsedGroups(grouping, { defaultCollapsed: true });

  const symbols = useMemo(() => symbolsInPortfolio(portfolio), [portfolio]);
  const {
    prices: liveQuotes,
    loading: pricesLoading,
    unknown: unknownSymbols,
    unavailable: unavailableSymbols,
    stale: liveStaleSymbols,
    refresh,
  } = usePrices(symbols);

  // The index strip keeps its own quotes, so "Refresh prices" has to ask it
  // too -- otherwise the button leaves the row of index moves sitting on
  // numbers up to that store's own refresh window old.
  const fetchIndexes = useMarketIndexStore((s) => s.fetchIndexes);
  const refreshPrices = () => {
    refresh();
    void fetchIndexes(true);
  };

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
        exposures: security?.exposures ?? [],
        instrumentType: security?.instrumentType ?? "other",
        instrumentTypeSource: security?.instrumentTypeSource ?? "auto",
        themes: security?.themes ?? [],
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

  useForecastValueSync(portfolio, prices, cloudSyncReady, (count) =>
    setFlash(`Updated ${count} forecast balance${count === 1 ? "" : "s"}.`),
  );

  // null = every account (the "all" scope); otherwise the exact account ids
  // the current scope covers, whether it names one account or one person.
  const scopeAccountIds = useMemo(
    () => accountIdsInScope(portfolio.accounts, scope),
    [portfolio.accounts, scope],
  );
  // A few consumers (the holdings table's account column, the transaction
  // form's default account) only make sense narrowed to a single account,
  // not a person who might hold several.
  const soleAccountId = scopeAccountIds?.length === 1 ? scopeAccountIds[0] : null;

  const analysis = useMemo(
    () =>
      analyzePortfolio(portfolio, prices, {
        accountIds: scopeAccountIds ?? undefined,
      }),
    [portfolio, prices, scopeAccountIds],
  );

  const accountNames = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, a.name])),
    [portfolio.accounts],
  );

  /**
   * Filters narrow which rows are listed, never how they're valued. Weights and
   * the summary tiles stay computed across the whole account scope, so a
   * filtered-down list can't make the remaining rows look like a bigger share
   * of the portfolio than they are.
   */
  // The shared filters alone, before Holdings adds its own side filter. This is
  // the slice the bar's count describes, and what every other tab narrows to.
  const scopedHoldings = useMemo(() => {
    const query = search.trim().toUpperCase();
    return analysis.holdings.filter((h) => {
      if (query && !h.symbol.includes(query) && !h.name.toUpperCase().includes(query)) return false;
      if (!matchesHoldingFacets(h, facets)) return false;
      return true;
    });
  }, [analysis.holdings, search, facets]);

  const visibleHoldings = useMemo(
    () => scopedHoldings.filter((h) => sideFilter === "all" || h.side === sideFilter),
    [scopedHoldings, sideFilter],
  );

  const assetClassOptions = useMemo(
    () => assetClassFacetOptions(analysis.holdings, facets),
    [analysis.holdings, facets],
  );
  const themeOptions = useMemo(
    () => themeFacetOptions(analysis.holdings, facets),
    [analysis.holdings, facets],
  );
  const instrumentTypeOptions = useMemo(
    () => instrumentTypeFacetOptions(analysis.holdings, facets),
    [analysis.holdings, facets],
  );
  const sharedFiltersActive = search !== "" || holdingFacetsActive(facets);

  const knownThemes = useMemo(() => allThemes(portfolio.securities.map((s) => s.themes)), [portfolio.securities]);
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
   *
   * Class and theme are the exception: Allocation owns those facets itself
   * now, and narrows a slice's own click without ever calling this, so those
   * two cases never actually fire -- they're here only because the dimension
   * type still has to name every value.
   */
  const handleDrillDown = (dimension: AllocationDimension, label: string) => {
    switch (dimension) {
      case "assetClass":
      case "theme":
        return;
      case "account": {
        setTab("holdings");
        const match = portfolio.accounts.find((a) => a.name === label);
        if (match) setScope(accountScope(match.id));
        break;
      }
      case "owner": {
        setTab("holdings");
        const person = people.find((p) => p.name === label);
        setScope(person ? ownerScope(person.id) : JOINT_OWNER_SCOPE);
        break;
      }
      case "accountType": {
        // No single-type scope exists, so this groups by account instead --
        // the rows land together, which is what the click was asking for.
        setTab("holdings");
        setGrouping("account");
        break;
      }
      case "symbol":
        setTab("holdings");
        setSearch(label);
        break;
      case "side":
        setTab("holdings");
        setSideFilter(label === "Short" ? "short" : "long");
        break;
    }
  };

  /**
   * Fills an empty tracker with the demo ledger, owned by this household's own
   * people and pointed at their own forecast accounts.
   *
   * Offered only while there is nothing here to lose -- it replaces the
   * portfolio outright, and a button that could do that to a real ledger has no
   * business sitting in the header.
   */
  const handleLoadDemo = () => {
    const demo = buildDemoPortfolio(people, scenario.accounts, new Date().toISOString().slice(0, 10));
    loadPortfolio(demo);
    const linked = demo.accounts.filter((a) => a.forecastAccountId !== null).length;
    setFlash(
      `Loaded ${demo.transactions.length} sample transactions across ${demo.accounts.length} accounts` +
        (linked > 0
          ? `, ${linked} of them linked to forecast accounts. Nothing syncs into the forecast until you turn it on per account.`
          : "."),
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

  // Handed to whichever performance view is showing so the switch renders in
  // that panel's own control row -- a second bar under the tabs would read as
  // a competing set of tabs.
  const performanceToggle = (
    <Segmented
      options={PERFORMANCE_VIEWS}
      value={performanceView}
      onChange={setPerformanceView}
      size="sm"
      ariaLabel="Performance view"
    />
  );

  return (
    <>
      <ThemeSync />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-panel px-6 py-3">
        <h1 className="text-[16px] font-semibold text-foreground">Portfolio</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label="Scope the portfolio to a person or account"
            className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground"
          >
            <option value={ALL_ACCOUNTS_SCOPE}>All accounts</option>
            <optgroup label="By person">
              {people.map((p) => (
                <option key={p.id} value={ownerScope(p.id)}>
                  {p.name}
                </option>
              ))}
              <option value={JOINT_OWNER_SCOPE}>Joint</option>
            </optgroup>
            <optgroup label="By account">
              {portfolio.accounts.map((a) => (
                <option key={a.id} value={accountScope(a.id)}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          </select>
          <Btn onClick={refreshPrices} title="Refetch quotes now">
            {pricesLoading ? "Refreshing…" : "Refresh prices"}
          </Btn>
          {portfolio.transactions.length === 0 && (
            <Btn onClick={handleLoadDemo} title="Fill the tracker with a fictional ledger to look at">
              Load sample data
            </Btn>
          )}
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
                  syncToForecast: true,
                  ownerId: null,
                  openingCashBalance: 0,
                });
              }
              setImporting(true);
            }}
          >
            Import transactions
          </Btn>
          <AccountMenu />
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

      <SummaryCards
        portfolio={portfolio}
        summary={summary}
        holdings={analysis.holdings}
        scopeAccountIds={scopeAccountIds}
        loadingQuotes={pricesLoading}
      />

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

      {/* Above the tabs because it applies to all of them, and below the
          summary cards because it does not apply to those -- the cards answer
          to the account picker in the header, which is the one scope control
          with a wider reach than the tabs. */}
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3 pt-1">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol or name"
          aria-label="Search the portfolio"
          className="w-56 rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
        />
        <FacetMenu
          label="Class"
          options={assetClassOptions}
          state={facets.assetClass}
          onChange={(next) => setFacets((f) => ({ ...f, assetClass: next }))}
        />
        <FacetMenu
          label="Theme"
          options={themeOptions}
          state={facets.theme}
          onChange={(next) => setFacets((f) => ({ ...f, theme: next }))}
        />
        <FacetMenu
          label="Type"
          options={instrumentTypeOptions}
          state={facets.instrumentType}
          onChange={(next) => setFacets((f) => ({ ...f, instrumentType: next }))}
        />
        <FilterStatus
          shown={scopedHoldings.length}
          total={analysis.holdings.length}
          noun="holdings"
          active={sharedFiltersActive}
          onClear={() => {
            setSearch("");
            setFacets(emptyHoldingFacets());
          }}
        />
      </div>

      <div className="border-b border-border px-6">
        <Segmented options={TABS} value={tab} onChange={setTab} size="sm" ariaLabel="Portfolio view" />
      </div>

      <main className="flex-1">
        {tab === "holdings" && (
          <div className="p-5">
            {/* Only the side filter is Holdings' own now -- search and the
                facets moved to the bar above the tabs. */}
            {hasShorts && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Segmented
                  options={SIDE_FILTERS}
                  value={sideFilter}
                  onChange={setSideFilter}
                  size="sm"
                  ariaLabel="Filter by position side"
                />
              </div>
            )}
            <HoldingsTable
              holdings={visibleHoldings}
              accountNames={accountNames}
              showAccount={soleAccountId === null}
              grouping={grouping}
              onGroupingChange={setGrouping}
              collapse={holdingCollapse}
              onSelect={setSelected}
            />
          </div>
        )}

        {tab === "allocation" && (
          <AllocationPanel
            holdings={analysis.holdings}
            accounts={portfolio.accounts}
            accountNames={accountNames}
            people={people}
            facets={facets}
            onFacetsChange={setFacets}
            onDrillDown={handleDrillDown}
          >
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-[13px] font-semibold text-foreground">Classify holdings</h3>
                <span className="text-[11.5px] text-dim-2">
                  {classifying
                    ? "Reading classes from the feed…"
                    : "Classes come from the feed. Edit a symbol to split its class, tag it, or fix its type."}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {/* Positions only -- cash is already a class, and offering to
                    reclassify it as an equity is an invitation to a wrong
                    allocation with no way to tell afterwards. */}
                {[
                  ...new Set(
                    analysis.holdings.filter((h) => h.kind === "position").map((h) => h.symbol),
                  ),
                ].map((symbol) => (
                  <SecurityEditorRow
                    key={symbol}
                    symbol={symbol}
                    security={securityFor(symbol)}
                    profile={securityProfiles[symbol]}
                    fetching={classifying}
                    knownThemes={knownThemes}
                    onSave={upsertSecurity}
                  />
                ))}
              </div>
            </div>
          </AllocationPanel>
        )}

        {tab === "performance" &&
          (performanceView === "overTime" ? (
            <PerformancePanel
              portfolio={portfolio}
              scopeAccountIds={scopeAccountIds}
              facets={facets}
              viewToggle={performanceToggle}
            />
          ) : (
            <BySymbolPanel
              holdings={analysis.holdings}
              closedLots={analysis.closedLots}
              search={search}
              facets={facets}
              onSelectSymbol={(symbol) => {
                setSearch(symbol);
                setTab("holdings");
              }}
              viewToggle={performanceToggle}
            />
          ))}

        {tab === "realized" && (
          <RealizedPanel
            closedLots={analysis.closedLots}
            summary={summary}
            accountNames={accountNames}
            search={search}
          />
        )}

        {tab === "transactions" && (
          <TransactionsPanel
            portfolio={portfolio}
            scopeAccountIds={scopeAccountIds}
            search={search}
            onSearchChange={setSearch}
          />
        )}

        {tab === "accounts" && (
          <AccountsPanel
            portfolio={portfolio}
            prices={prices}
            forecastAccounts={scenario.accounts}
            people={people}
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
