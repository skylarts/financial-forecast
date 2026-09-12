# Average-cost basis for mutual funds

Status: proposal. Nothing here is built.

## The gap

The lot engine is specific-identification where a statement names lots and FIFO otherwise. That is what brokers do for stocks and ETFs. For **mutual funds** every custodian this household uses defaults to **average cost**: a sale's basis is the average price of every share held in that account, not the oldest lots' prices. So for a mutual fund in a taxable account, the realized gain the app shows will never match the 1099-B, and for the funds in the 401(k)s and 457 the realized figures on the Realized and By-stock tabs disagree with the statements for no reason the reader can see.

To be clear about what is and isn't at stake: in a 401(k) or IRA the basis method changes nothing anyone owes, since withdrawals are taxed as income regardless. It changes the *analysis* figures, and it makes the app's numbers reconcile to the custodian's. In a taxable account holding a mutual fund it changes the tax figure itself.

## The rule being modelled

Single-category average cost, which is what the custodians use:

- The basis of every share of a fund in one account is the average basis of all shares held there. Reinvested dividends and transfers in join the pool at their own cost and move the average.
- A sale takes shares oldest-first for the **holding period** (that part stays FIFO by IRS rule) but books every share at the **average** basis.
- After a partial sale the remaining shares all carry the average, so a later purchase moves the average again from there.
- It is per fund, per account. Never for stocks, ETFs, options, or short positions.

## Where the method is decided

A new optional field on the security record: `costMethod: "lots" | "average"`, with the same `auto`/`manual` source convention the asset class already uses.

- **Auto default:** `average` when the security's instrument type is `mutual_fund`, `lots` for everything else. This makes the funds reconcile without anyone touching anything.
- **Override:** a "Cost basis" select in the classify-holdings editor on the Allocation tab, next to the type and class. Someone whose broker elected FIFO for a fund sets it there once.

A ledger's existing figures change only for securities the feed has classified as mutual funds. That is the point, but it is also a silent change to history, so:

- The Realized tab shows the method on every lot ("Avg" beside the basis, with the average per share on hover) and in the group headers.
- The first time a ledger's realized total moves because of this, the flash banner says so once: "Mutual funds are now on average cost, matching how custodians report them. Change it per fund in Classify holdings."

## What the engine does

`buildLotLedger` today takes only the transactions and is memoised on that array. It gains a second argument, the set of symbols on average cost (a sorted, joined string is the cache key alongside the array), so the memo and its invariants keep holding: the array is never mutated, lots stay append-only, the FIFO cursor still advances.

Inside the disposal loop, for a symbol on average cost:

1. Before drawing, compute `avg = Σ costBasis / Σ quantity` over the position's live long lots in that account.
2. Draw shares exactly as now (named lots first, then oldest-first), but book each drawn share at `avg` rather than at its own lot's per-share basis. The `ClosedLot` carries `basisMethod: "average"` and the average per share.
3. After the draw, re-level the remaining lots so each carries `quantity × avg`. Totals are unchanged by this; only the split between lots moves.

Because the total basis of the open position is invariant under re-levelling, everything that reads the *sum* of open basis is unaffected: the Holdings cost-basis column, the summary card, and the value the forecast push writes into `startingCostBasis`. Only per-lot figures and realized gains move.

Named lot ids on an average-cost fund still choose which shares leave (for the holding period). Their basis is the average regardless, and the row gets no warning: the statement named a lot because that is what its system prints, not because the basis was lot-specific.

## Files touched

- `src/domain/portfolio/security.ts`: `costMethod` and `costMethodSource`, both optional with defaults, no migration.
- `src/engine/portfolio/lots.ts`: the disposal loop above, the memo key, `basisMethod` on `ClosedLot`.
- `src/engine/portfolio/metrics.ts` and `src/store/usePortfolioStore.ts`: pass the average-cost symbol set to `buildLotLedger` (three call sites).
- `src/components/portfolio/SecurityEditor.tsx`: the select.
- `src/components/portfolio/RealizedPanel.tsx` and `PositionDetail.tsx`: the method marker.
- Tests: the engine cases below; the classify-editor default; the memo key.

## Engine test cases

- Buy 10 @ $10, buy 10 @ $20, sell 5: basis $75 (average $15), not $50 (FIFO). Remaining 15 shares carry $225 total.
- Same, then buy 10 @ $30 and sell 10: average is now ($225 + $300) / 25 = $21; sale basis $210.
- Reinvested dividend joins the pool at its own price.
- Holding period follows the oldest shares: a sale after the second buy but within a year of it is still long-term for the shares the first buy covers.
- A fund on `lots` is untouched by every case above (regression on today's numbers).
- Short positions and options ignore the method.
- Two accounts holding the same fund average separately.

## What could go wrong

- **History changes on upgrade.** Covered above by the auto default being limited to feed-classified mutual funds, the per-lot marker, and the one-time banner. If that still feels like too much, the alternative is default `lots` for everyone and a suggestion banner instead; say which.
- **The feed's classification is wrong.** A fund the feed calls a stock stays on lots. The override fixes any one case, and the marker makes a wrong one visible.
- **Cache key.** Forgetting to include the method set in the memo key would serve one method's ledger for the other. The key is built in one place and tested.
- **Capital Mindset export.** It exports transactions, not lots, so it is unaffected.

## Not in this proposal

- Average cost for stocks or ETFs (no custodian defaults to it).
- LIFO or highest-in-first-out (explicitly out of scope in the plan's defaults).
- Reconstructing which method a custodian *actually* applied to a past sale from the statement; that is what the override is for.

## Size

One PR. Roughly 100 lines in the engine, 40 in the UI, and a dozen tests.
