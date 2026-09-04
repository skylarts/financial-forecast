"use client";

import { useEffect, useMemo, useState } from "react";
import type { Id } from "@/domain";
import dynamic from "next/dynamic";
import {
  allThemes,
  formatOptionSymbol,
  normalizeSymbol,
  type PortfolioAccount,
  type TransactionType,
} from "@/domain/portfolio";
import { analyzePortfolio, type PriceMap } from "@/engine/portfolio/metrics";
import { SecurityEditorRow } from "./SecurityEditor";
import { SummaryCards } from "./SummaryCards";
import type { ExpiredContract } from "@/engine/portfolio/expiredContracts";
import { usePortfolioStore, symbolsInPortfolio } from "@/store/usePortfolioStore";
import { symbolsEverTraded } from "@/lib/portfolio/classifiableSymbols";
import { usePortfolioCloudSync } from "@/store/usePortfolioCloudSync";
import { useCloudSync } from "@/store/useCloudSync";
import { useForecastValueSync } from "@/store/useForecastValueSync";
import { usePlanStore } from "@/store/usePlanStore";
import { usePrices } from "@/store/usePriceStore";
import { useSecurityProfiles } from "@/store/useSecurityProfiles";
import { money, shortDate } from "@/lib/portfolio/format";
import { buildDemoPortfolio } from "@/lib/portfolio/demoPortfolio";
import { Btn, Segmented } from "@/components/ui/controls";
import { ThemeSync } from "@/components/layout/ThemeToggle";
import { NavMenuButton } from "@/components/layout/SideNav";
import { HoldingsTable, type HoldingGrouping } from "./HoldingsTable";
import { useCollapsedGroups } from "./grouping";
import { PositionDetail, type PositionSelection } from "./PositionDetail";
import { ImportDialog, type ImportAssignment } from "./ImportDialog";
import { AccountsPanel } from "./AccountsPanel";
import { PortfolioMenu } from "./PortfolioMenu";
import { TransactionsPanel } from "./TransactionsPanel";
import { RealizedPanel } from "./RealizedPanel";
import type { AllocationDimension } from "./AllocationPanel";
import { BasketManager } from "./BasketManager";
import { CollapsibleSection } from "./CollapsibleSection";
import { BySymbolPanel } from "./BySymbolPanel";
import { PriceFeedNotice } from "./PriceFeedNotice";
import { SchwabBadge } from "./SchwabBadge";
import { SchwabConnection } from "./SchwabConnection";
import { ExpiredContractsNotice } from "./ExpiredContractsNotice";
import { FilterStatus } from "./FilterStatus";
import { FilterChips, FilterMenu, type FilterSection } from "./FilterMenu";
import { EMPTY_FACET, type FacetState } from "@/components/ui/facets";
import {
  accountFacetOptions,
  accountIdsForFacet,
  assetClassFacetOptions,
  emptyHoldingFacets,
  holdingFacetsActive,
  instrumentTypeFacetOptions,
  matchesHoldingFacets,
  themeFacetOptions,
  type HoldingFacets,
} from "./filters";
import { useMarketIndexStore } from "@/store/useMarketIndexes";

/** Every section in the filter panel: the three holding facets, plus accounts. */
type FilterKey = "account" | (keyof HoldingFacets & string);

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

export function PortfolioApp() {
  const portfolio = usePortfolioStore((s) => s.portfolio);
  const hasHydrated = usePortfolioStore((s) => s.hasHydrated);
  const importTransactions = usePortfolioStore((s) => s.importTransactions);
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const removeTransactions = usePortfolioStore((s) => s.removeTransactions);
  const undoImport = usePortfolioStore((s) => s.undoImport);
  const upsertSecurity = usePortfolioStore((s) => s.upsertSecurity);
  const addBasket = usePortfolioStore((s) => s.addBasket);
  const renameBasket = usePortfolioStore((s) => s.renameBasket);
  const removeBasket = usePortfolioStore((s) => s.removeBasket);
  const assignToBasket = usePortfolioStore((s) => s.assignToBasket);
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
  const [selected, setSelected] = useState<PositionSelection | null>(null);
  const [importing, setImporting] = useState(false);
  /**
   * The banner message, and the import it can take back.
   *
   * `undoBatch` rides along with the message rather than sitting in its own
   * state so the two can never come apart: an Undo offered next to a later,
   * unrelated message would still throw away the earlier import, and that is
   * exactly the kind of button somebody presses. Setting any other message
   * clears it, because `setFlash` cannot carry one.
   */
  const [flash, setFlashState] = useState<{ text: string; undoBatch?: string } | null>(null);
  const setFlash = (text: string | null) => setFlashState(text === null ? null : { text });

  // Search and the three facets are shared by every tab that can read them,
  // rather than re-declared on each. They used to be four search boxes and
  // three facet sets with seven independent memories, so narrowing to Crypto
  // on Allocation and moving to Performance meant picking Crypto again.
  const [search, setSearch] = useState("");
  const [facets, setFacets] = useState<HoldingFacets>(emptyHoldingFacets());
  /** Which accounts are in play. Empty (the default) means all of them. */
  const [accountFacet, setAccountFacet] = useState<FacetState>(EMPTY_FACET);
  const [sideFilter, setSideFilter] = useState<SideFilter>("all");
  /**
   * Grouped by account out of the box. A holding's account is the first thing
   * that distinguishes two lines that otherwise read the same -- the same fund
   * held in a taxable account and in a Roth is two different positions with two
   * different tax stories -- so an ungrouped list buries the one split that
   * always matters. Opens expanded: see `startExpanded`.
   */
  const [grouping, setGrouping] = useState<HoldingGrouping>("account");
  const holdingCollapse = useCollapsedGroups(grouping, {
    defaultCollapsed: true,
    startExpanded: true,
  });

  const symbols = useMemo(() => symbolsInPortfolio(portfolio), [portfolio]);
  // Classification covers everything ever held, not just what's open now --
  // the Performance and Holdings filters read it for closed positions too.
  // Quotes stay on the narrow list above; a sold position has no price to ask
  // for, but it still has an asset class.
  const classifiableSymbols = useMemo(() => symbolsEverTraded(portfolio), [portfolio]);
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
        profileCheckedAt: security?.profileCheckedAt ?? null,
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

  const { profiles: securityProfiles, loading: classifying } = useSecurityProfiles(classifiableSymbols);

  useForecastValueSync(portfolio, prices, cloudSyncReady, (count) =>
    setFlash(`Updated ${count} forecast balance${count === 1 ? "" : "s"}.`),
  );

  // null = every account; otherwise the exact ids the account facet leaves in
  // play, sleeves included.
  const scopeAccountIds = useMemo(
    () => accountIdsForFacet(portfolio.accounts, accountFacet),
    [portfolio.accounts, accountFacet],
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
   * Every transaction the current account scope can see. The detail drawer
   * narrows this to one name itself, so a position opened from Realized or
   * Allocation -- neither of which carries a holding -- still lists its own
   * ledger without either panel having to hand one over.
   */
  const scopedTransactions = useMemo(() => {
    if (scopeAccountIds === null) return portfolio.transactions;
    // A Set, because this is asked once per transaction and the scope can name
    // every account in the portfolio.
    const ids = new Set(scopeAccountIds);
    return portfolio.transactions.filter((tx) => ids.has(tx.accountId));
  }, [portfolio.transactions, scopeAccountIds]);

  /**
   * Opens the detail drawer on a name, from wherever it was clicked.
   *
   * Holdings clicks name an account, because a row there is one account's side
   * of a position. Everywhere else -- a realized lot, an allocation slice, a
   * by-stock row -- means the name itself, across the whole scope.
   */
  const openPosition = (symbol: string, accountId: Id | null = null) =>
    setSelected({ symbol, accountId });

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

  // Same shared scope as everywhere else, narrowed to positions -- cash is
  // already a class, so there's nothing on it to classify.
  /** Every position held in scope, whatever the filters say -- the pool a
   *  basket picks from. */
  const basketableSymbols = useMemo(
    () => [...new Set(analysis.holdings.filter((h) => h.kind === "position").map((h) => h.symbol))],
    [analysis.holdings],
  );

  const classifiableHoldingSymbols = useMemo(
    () => [...new Set(scopedHoldings.filter((h) => h.kind === "position").map((h) => h.symbol))],
    [scopedHoldings],
  );

  /**
   * Holdings the feed and the user have both left as "other" -- the ones the
   * allocation charts can't place. Counted over what's actually on screen, so
   * the figure matches the list it summarises.
   */
  const unclassifiedCount = useMemo(
    () =>
      classifiableHoldingSymbols.filter((symbol) => {
        const security = portfolio.securities.find((s) => normalizeSymbol(s.symbol) === symbol);
        return (security?.assetClass ?? "other") === "other";
      }).length,
    [classifiableHoldingSymbols, portfolio.securities],
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
  const accountOptions = useMemo(
    () => accountFacetOptions(portfolio.accounts, people),
    [portfolio.accounts, people],
  );
  // What the row count under the bar describes: the filters that narrow rows
  // *within* the current set of accounts. The account facet is deliberately
  // not one of them -- it changes which holdings exist at all, so it moves the
  // count's total rather than the number in front of it, and "12 of 12" would
  // be the only thing it could ever say.
  const sharedFiltersActive = search !== "" || holdingFacetsActive(facets);

  const clearAllFilters = () => {
    setSearch("");
    setFacets(emptyHoldingFacets());
    setAccountFacet(EMPTY_FACET);
  };

  // One shape for all four, so the panel and the chips can walk them without
  // knowing which facet is which. The order is widest-first: Accounts decides
  // which accounts are valued at all, then Type sorts the instruments, then
  // Class and Theme cut across what is left.
  const filterSections = useMemo<FilterSection<FilterKey>[]>(
    () => [
      { key: "account", label: "Accounts", options: accountOptions, state: accountFacet },
      { key: "instrumentType", label: "Type", options: instrumentTypeOptions, state: facets.instrumentType },
      { key: "assetClass", label: "Class", options: assetClassOptions, state: facets.assetClass },
      { key: "theme", label: "Theme", options: themeOptions, state: facets.theme },
    ],
    [accountOptions, accountFacet, assetClassOptions, themeOptions, instrumentTypeOptions, facets],
  );
  const setFacet = (key: FilterKey, next: FacetState) => {
    if (key === "account") setAccountFacet(next);
    else setFacets((f) => ({ ...f, [key]: next }));
  };

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

  const handleImport = (assignments: ImportAssignment[]) => {
    // A statement dividend that lands on a payment the sync already wrote
    // under its ex-date supersedes that estimate rather than duplicating it.
    const replacedIds = assignments
      .map(({ row }) => row.syncMatchId)
      .filter((id): id is string => id !== null);
    const replaced = replacedIds.length > 0 ? removeTransactions(replacedIds) : 0;

    const batchId = importTransactions(
      assignments.map(({ accountId, row }) => ({ accountId, draft: row.draft })),
    );
    setImporting(false);
    setFlashState({
      text:
        `Imported ${assignments.length} transaction${assignments.length === 1 ? "" : "s"}` +
        (replaced > 0 ? `, replacing ${replaced} synced dividend${replaced === 1 ? "" : "s"}.` : "."),
      undoBatch: batchId,
    });
  };

  /**
   * Takes back the import the banner is describing.
   *
   * Offered only while that banner is up: it is the fix for having just sent a
   * file to the wrong account, which is the moment you notice. Once the message
   * is gone the import is ordinary history, and unpicking it belongs to the
   * transactions list, where the rows can be seen before they are deleted.
   *
   * Dividends the import superseded stay gone. They were the price feed's own
   * estimates rather than anything the user entered, and the next sync writes
   * them again -- so the message says so instead of implying a clean reversal.
   */
  const handleUndoImport = (batchId: string, replacedSynced: boolean) => {
    const removed = undoImport(batchId);
    setFlash(
      `Removed ${removed} imported transaction${removed === 1 ? "" : "s"}.` +
        (replacedSynced ? " Synced dividends it replaced will come back on the next sync." : ""),
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
   * Class, theme, and type are the exception: Allocation owns those facets
   * itself now, and narrows a slice's own click without ever calling this, so
   * those cases never actually fire -- they're here only because the
   * dimension type still has to name every value.
   */
  const handleDrillDown = (dimension: AllocationDimension, label: string) => {
    switch (dimension) {
      case "assetClass":
      case "theme":
      case "instrumentType":
        return;
      case "account": {
        setTab("holdings");
        const match = portfolio.accounts.find((a) => a.name === label);
        if (match) setAccountFacet({ mode: "include", selected: new Set([match.id]) });
        break;
      }
      case "owner": {
        setTab("holdings");
        const person = people.find((p) => p.name === label);
        const ownerId = person?.id ?? null;
        // Top-level accounts only: a sleeve comes along with its parent, and
        // naming it as well would only put a second chip on the same account.
        const owned = portfolio.accounts.filter(
          (a) => a.ownerId === ownerId && a.parentAccountId === null,
        );
        setAccountFacet({ mode: "include", selected: new Set(owned.map((a) => a.id)) });
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
        // Handled by the panel itself, which opens the detail drawer rather
        // than leaving for Holdings.
        return;
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
      {/* The same shape as the forecast's header, deliberately: a brand mark
          and the tool's name on the left, the actions that change data hard
          right, and the top-level views on their own line underneath. Two
          tools that share a shell should not each invent their own chrome.

          No panel fill here -- the header sits on the page background so the
          lighter panel surfaces below it (the control bar, the cards, the
          tables) read as things layered *on* the page rather than as more
          chrome. */}
      <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-border px-3 py-3 sm:px-6 sm:py-3.5">
        {/* Same as the forecast: the name is also the handle on the section
            drawer. */}
        <h1 className="text-[15px] font-bold leading-tight tracking-tight">
          <NavMenuButton>Portfolio</NavMenuButton>
        </h1>

        {/* Pinned to the top-right corner at every width, same as the forecast:
            the corner belongs to the controls that act on your data, not to a
            tab strip that only says where you are. */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
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
                  parentAccountId: null,
                  schwabAccountHash: null,
                });
              }
              setImporting(true);
            }}
          >
            <span className="whitespace-nowrap">
              Import<span className="hidden sm:inline"> transactions</span>
            </span>
          </Btn>
          <Btn
            onClick={refreshPrices}
            title="Refetch quotes now"
            ariaLabel="Refresh prices"
            className="px-2.5"
          >
            <span aria-hidden className={pricesLoading ? "inline-block animate-spin" : undefined}>
              ↻
            </span>
          </Btn>
          {/* Beside the refresh control because it answers the question that
              control raises: refreshed from where. Hidden on a phone, where
              its two words are the difference between this bar fitting on one
              line and not -- the same status is spelled out in the feed notice
              further down the page. */}
          {/* `contents`, not `inline-flex`: the badge renders nothing until a
              Schwab app is configured, and a wrapper that generates a box
              would still claim one of this row's gaps when it is empty. */}
          <span className="hidden sm:contents">
            <SchwabBadge />
          </span>
          <PortfolioMenu
            portfolio={portfolio}
            canLoadDemo={portfolio.transactions.length === 0}
            onLoadDemo={handleLoadDemo}
          />
        </div>

        {/* The six top-level views, as an underline strip on its own line --
            the forecast's exact treatment. They used to be a filled segmented
            control further down the page, which put the same solid accent fill
            on "where you are" as on the buttons that do something, and buried
            the tab strip under three bands of summary and notices.

            `w-full` claims its own line at every width, and the negative margin
            bleeds it to the screen edge so a tab clipped by the edge is what
            tells you there is more to swipe to on a phone. */}
        <nav
          className="scroll-strip -mx-3 -mb-3 flex w-full items-center gap-0.5 px-3 sm:-mx-6 sm:-mb-3.5 sm:px-6"
          aria-label="Portfolio views"
        >
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-current={t.value === tab}
              onClick={() => setTab(t.value)}
              className={`whitespace-nowrap border-b-2 px-3.5 py-2 pb-3.5 text-[13px] transition-colors ${
                t.value === tab
                  ? "border-accent font-semibold text-foreground"
                  : "border-transparent font-medium text-dim hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* The control bar: everything that narrows what the views below show,
          in one strip on the panel surface directly under the header. It is
          the forecast's ViewBar in the same position with the same treatment
          -- there, the year range and dollar mode; here, the search box and
          the filters.

          Accounts used to be a dropdown of its own out here, next to the
          filter button. One choice at a time meant "her Roth and the joint
          brokerage" was not a question you could ask, and it put the answer to
          "which accounts?" in a different place from every other answer. It is
          a section in the panel now, and its chips sit with the rest. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-panel px-3 py-2 sm:px-6 sm:py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search symbol or name"
            aria-label="Search the portfolio"
            className="min-w-[8rem] flex-1 rounded-md border border-border bg-panel-2 px-2 py-1 text-[12px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent sm:w-56 sm:flex-none"
          />
          <FilterMenu sections={filterSections} onChange={setFacet} onClearAll={clearAllFilters} />
          <FilterChips sections={filterSections} onChange={setFacet} />
        </div>
        <FilterStatus
          shown={scopedHoldings.length}
          total={analysis.holdings.length}
          noun="holdings"
          active={sharedFiltersActive}
          onClear={clearAllFilters}
        />
      </div>

      {/* Banners, in the content gutter as inset cards rather than as
          full-bleed bands of panel-2. Full-bleed read as more header: on a
          quiet day the page opened with four stacked strips of chrome before
          any of your money appeared. As cards they sit in the same column as
          the summary and the tables, and disappear cleanly when there is
          nothing to say (`empty:hidden` collapses the gap too). */}
      <div className="flex flex-col gap-3 px-3 pt-4 sm:px-6 empty:hidden">
        {flash && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 p-3 text-[12.5px] text-foreground">
            <span>{flash.text}</span>
            <div className="flex shrink-0 items-center gap-3">
              {flash.undoBatch && (
                <button
                  type="button"
                  onClick={() => handleUndoImport(flash.undoBatch!, flash.text.includes("replacing"))}
                  className="text-accent hover:underline"
                  title="Remove every transaction this import added"
                >
                  Undo import
                </button>
              )}
              <button type="button" onClick={() => setFlash(null)} className="text-dim hover:text-foreground">
                Dismiss
              </button>
            </div>
          </div>
        )}

        {analysis.warnings.length > 0 && (
          <div className="rounded-lg border border-accent/40 bg-accent/10 p-3">
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

        <ExpiredContractsNotice
          contracts={analysis.expiredContracts}
          onRecord={handleRecordExpiry}
        />

        <SchwabConnection />

        <PriceFeedNotice
          unknown={displayUnknown}
          unavailable={displayUnavailable}
          stale={staleSymbols}
          onRetry={refresh}
          retrying={pricesLoading}
        />
      </div>

      <main className="flex-1">
        {/* The summary cards belong to Holdings, the way the forecast's KPI
            bento belongs to its Overview -- Holdings is where you come to see
            what you own, and these four cards are that question answered in
            one line each.

            They used to render above every tab. With the tab strip up in the
            header they read as part of whichever tab is showing, which they
            are not, and on two tabs they printed the same figure twice: the
            Performance card sat directly above Performance's own return
            tiles, and Gains & losses above Realized's. A number that appears
            twice on one screen invites the reader to look for the difference
            between them. */}
        {tab === "holdings" && (
          <>
            <SummaryCards
              portfolio={portfolio}
              summary={summary}
              holdings={analysis.holdings}
              scopeAccountIds={scopeAccountIds}
              loadingQuotes={pricesLoading}
            />
            <div className="px-3 pb-4 sm:px-6">
              {/* Only the side filter is Holdings' own now -- search and the
                  facets live in the control bar under the header. */}
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
                onSelect={(holding) => openPosition(holding.symbol, holding.accountId)}
              />
            </div>
          </>
        )}

        {tab === "allocation" && (
          <AllocationPanel
            holdings={analysis.holdings}
            accounts={portfolio.accounts}
            accountNames={accountNames}
            people={people}
            baskets={portfolio.baskets}
            facets={facets}
            onFacetsChange={setFacets}
            onDrillDown={handleDrillDown}
            onSelectSymbol={(symbol) => openPosition(symbol)}
          >
            {/* Deliberately above the classify list rather than inside it: a
                basket is about which holdings belong together, which is a
                different question from what each one *is*, and burying it in a
                per-symbol list would mean setting one up a row at a time.
                Scoped to every held symbol, not the filtered set -- you can't
                add a holding to a basket that the filters have hidden. */}
            <BasketManager
              baskets={portfolio.baskets}
              symbols={basketableSymbols}
              onCreate={addBasket}
              onRename={renameBasket}
              onRemove={removeBasket}
              onAssign={assignToBasket}
            />
            {/* Folded away like Baskets. Classifying is setup work done once,
                and the summary carries the count of what still has no class,
                so a shut drawer never hides that there's work in there. */}
            <CollapsibleSection
              title="Classify holdings"
              summary={
                classifying
                  ? "Reading classes from the feed…"
                  : unclassifiedCount > 0
                    ? `${unclassifiedCount} unclassified — edit a symbol to set its class, split it, or tag it.`
                    : "Classes come from the feed. Edit a symbol to split its class, tag it, or fix its type."
              }
            >
              <div className="flex flex-col gap-1.5">
                {/* Positions only -- cash is already a class, and offering to
                    reclassify it as an equity is an invitation to a wrong
                    allocation with no way to tell afterwards. Scoped to the
                    same search/facets/account filters as the rest of the
                    tab, so narrowing to e.g. Crypto up top also narrows what
                    there is to classify down here. */}
                {classifiableHoldingSymbols.length === 0 ? (
                  <p className="py-4 text-center text-[12.5px] text-dim">
                    {sharedFiltersActive
                      ? "No holdings match those filters."
                      : "Nothing to classify yet."}
                  </p>
                ) : (
                  classifiableHoldingSymbols.map((symbol) => (
                    <SecurityEditorRow
                      key={symbol}
                      symbol={symbol}
                      security={securityFor(symbol)}
                      profile={securityProfiles[symbol]}
                      fetching={classifying}
                      knownThemes={knownThemes}
                      onSave={upsertSecurity}
                    />
                  ))
                )}
              </div>
            </CollapsibleSection>
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
              onSelectSymbol={(symbol) => openPosition(symbol)}
              viewToggle={performanceToggle}
            />
          ))}

        {tab === "realized" && (
          <RealizedPanel
            closedLots={analysis.closedLots}
            summary={summary}
            accountNames={accountNames}
            search={search}
            onSelectSymbol={(symbol) => openPosition(symbol)}
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
        <PositionDetail
          // Remounted per position, so one name's chart range and custom dates
          // never carry over onto the next one opened.
          key={`${selected.symbol}:${selected.accountId ?? "all"}`}
          selection={selected}
          holdings={analysis.holdings}
          closedLots={analysis.closedLots}
          transactions={scopedTransactions}
          accountNames={accountNames}
          onClose={() => setSelected(null)}
        />
      )}

      {importing && (
        <ImportDialog
          accounts={portfolio.accounts}
          existingTransactions={portfolio.transactions}
          securities={portfolio.securities}
          onImport={handleImport}
          onClose={() => setImporting(false)}
        />
      )}
    </>
  );
}
