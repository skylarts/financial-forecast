# Financial Forecast

Two tools in one Next.js app, sharing sign-in, theme, and UI:

- **Forecast** (`/`) projects a household's finances year by year: accounts, income, expenses, one-off events, a home purchase, taxes, required minimum distributions, and a drain order for retirement withdrawals. It answers "will this plan hold" and shows where the money flows each year.
- **Portfolio** (`/portfolio`) tracks the real accounts behind that plan: holdings, tax lots, cash, realized and unrealized gains, dividends, and time-weighted performance against a benchmark. A linked portfolio account can push its live market value into the forecast's starting balance, so the two tools stop drifting apart.

## How the forecast works

**One deterministic simulation.** The engine (`src/engine/forecastScenario.ts`) walks the plan month by month: growth, every income and expense posting, contributions, mortgage payments, required minimum distributions, the surplus split, and the withdrawal cascade that covers a shortfall in Extra Savings, the one mandatory spending account. It runs the whole horizon a few times so each year's withholding is sized at the rate the year's own income implies, then reports the exact federal bill from the 2026 IRS tables indexed forward. Always debug with `projectScenario`; the single-pass `forecastScenario` skips tax when it is given no rate map.

**Every amount is today's dollars.** Inputs are entered in today's money; the engine inflates them from the plan start and the views deflate the results back when "Today's $" is selected. A blank growth rate means "keep pace with inflation", except a pension's, which means no raise.

**What the plan knows about people.** A person's planning-end age is the age they are modelled as living to: their salary stops, a pension continues at its survivor share, the survivor keeps the larger Social Security check, their accounts pass to the survivor for the 59½ and RMD rules, and a married household files single from the next year. Roth conversions (a set amount, or "fill to the top of a bracket" each December), rollovers and loan payoffs are their own events.

**Dates that follow a retirement.** A pension, a Social Security claim, a healthcare bridge, a Roth-conversion window: in real life these are consequences of retiring, not fixed dates. Any income, expense or event date can be *linked* to a person's retirement plus or minus a number of months instead of typed in (`src/domain/anchor.ts`), and changing that person's retirement age then moves every linked date with it. The rule is what is stored; the concrete date is recomputed on every load and every edit and written back into the ordinary `startDate`/`endDate`, so the engine, the exports and the tables still see nothing but plain dates. An end link resolves to the day *before* the retirement, matching the trim the engine already applies to a salary.

**Withdrawal strategy.** A preset (taxable first, tax-deferred first, or a bit of everything) derives the drain order from the accounts, so a new account is never left unreachable; "Custom" reads the hand-built order. A cash buffer target keeps Extra Savings topped up in retirement. One expected return can stand in for every investment account's own rate.

**Healthcare** is modelled by stage when switched on: an employer plan while a salary runs, then a marketplace plan with the premium tax credit computed from the plan's own income each year (federal age curve, current-law or enhanced schedule), COBRA or a retiree plan, then Medicare with Part B, Part D, a supplement and IRMAA from income two years back. The 2026 tables live in one block in `src/engine/healthcare.ts`.

**Stress tests** are the same plan re-run under one bad assumption: lower returns, a bear market in the retirement year, higher inflation, a Social Security cut, a longer life, or all at once, with adjustable severity. They are deterministic, so a row answers "what if" exactly.

**Saving.** The plan autosaves to the browser and, when signed in, to the household's cloud row, under the same four rules as the portfolio (below): a failed pull never pushes, an empty plan never overwrites a full one, and a dated copy is kept before any replacement or delete. The Data menu offers a backup, a restore, the kept copies, a CSV of the projection, a print view, and a Markdown export written for an AI assistant.

## Running it

```bash
npm install
npm run dev -- --port 3001 --experimental-https
```

Then open <https://127.0.0.1:3001>. TLS is needed because Schwab only accepts `https` callbacks; without a Schwab connection plain `npm run dev` works too.

Checks:

```bash
npx vitest run        # unit tests, including the pure engine
npx tsc --noEmit      # types
npx eslint src        # lint
```

Copy `.env.example` to `.env.local` for Supabase and Schwab settings. With no Supabase project configured the app runs single-user with everything stored in the browser.

## How the portfolio tracker works

**Transactions are the only source of truth.** Holdings, tax lots, cash balances, weights, and every performance figure are replayed from the ledger on each render and never stored. Editing or re-importing a row can therefore never leave a stale derived total behind. Do not add cached totals.

**Lot accounting** is specific-ID where a statement supplies a lot id, FIFO otherwise. Same-day buys replay before same-day sells. Transfers out deplete lots without realizing anything. Short positions are tracked on their own side so a sale can never be matched against a short, and a cover never against a long. Option contracts use OCC symbols and a 100-share multiplier.

**Cash is replayed** from deposits, withdrawals, trades, dividends, interest, and fees. An account's `openingCashBalance` is only what it held before its first recorded row. A funded account may go negative, which is what a margin balance is.

**Performance** is a daily time-weighted series built from the ledger and the feed's price history, with contributions and withdrawals treated as external flows. The summary card's money-weighted figure is the ledger's own IRR and answers a different question. Split-adjusted feed prices are put back into the shares actually held on each day using the feed's split calendar where the ledger has a matching `split` row, and inferred from the trades themselves where it does not.

## Importing statements

Open **Import transactions** and paste or upload a file. The dialog detects the format from the header row:

| Preset | What it knows |
| --- | --- |
| Schwab CSV | The transactions download for a brokerage or IRA. `Reinvest Dividend` and `Qual Div Reinvest` are dividends; only `Reinvest Shares` is the purchase. Journals, MoneyLink rows and wires are read by sign. `MM/DD/YYYY as of MM/DD/YYYY` keeps the trade date. |
| Fidelity CSV | The history download. The ticker is read out of the action text when the symbol column is blank; option contracts are built from the prose; the margin mark-to-market rows are dropped as bookkeeping. |
| Workplace plan export | A 401(k) or 457 export with Investment, Contribution, Activity and Units columns. Fund names are mapped to tickers in the dialog; the Contribution column routes rows to pre-tax and Roth sleeves. |
| This app's export | The CSV the tracker writes, recognised by its exact type names, so a corrected export imports back with no mapping. |

Anything the preset's table cannot answer is held in a **Needs a decision** pile and the import stays disabled until each row is confirmed or skipped. Duplicates are recognised by a fingerprint of the source row and, failing that, by what the row means (date, type, symbol, shares and price), so re-importing an overlapping export adds only what is new. The dialog also offers `split` rows from the feed's calendar for positions held through a split the file does not record, and links a deposit to a matching withdrawal in another tracked account as a transfer.

A split workplace account is modelled as a parent with two sleeves, one per tax treatment, so the forecast sees two accounts while the custodian sees one.

## Price feeds

Quotes prefer Schwab when a brokerage is connected and fall back to the public feed. History prefers the public feed even when Schwab is connected, because Schwab serves split-adjusted closes without saying a split happened, and the split events are what let a past close be restated into the shares held that day. Option contracts are quoted by both feeds. A quote older than the last completed trading day shows its date beside the price.

Connecting a brokerage is optional. With no Schwab app configured the app uses the public feed for everything and the connection banner never appears.

### Connecting Schwab

1. Create an app at [developer.schwab.com](https://developer.schwab.com) with the **Accounts and Trading** and **Market Data** products.
2. Register `https://127.0.0.1:3001/api/schwab/callback` as its callback URL.
3. Put the app key and secret in `.env.local` (see `.env.example`), and set `SCHWAB_ENCRYPTION_KEY` (`openssl rand -hex 32`). Connecting is refused without it rather than storing a token in plaintext.
4. Open the portfolio menu and choose **Schwab connection**.

Schwab connections expire after seven days and cannot be renewed without a person signing in again. The banner starts asking two days out; if it lapses, prices fall back to the public feed and nothing else changes.

### Hosting it for more than one person

A Schwab connection belongs to a person, not the deployment. Where Supabase is configured, each user's token is stored in their own `schwab_connections` row, encrypted, and reachable only by them under row-level security. Every Schwab route requires a signed-in user. Run `supabase/schwab_connections.sql` once, set `SCHWAB_APP_KEY`, `SCHWAB_APP_SECRET`, and a `SCHWAB_CALLBACK_URL` on the production domain, and register that callback on the Schwab app. Schwab requires commercial approval before an app may connect other people's accounts; without it, each user registers their own app and supplies their own key and secret in the UI.

## Sync safety

The portfolio syncs to Supabase as one document per household. The rules in `src/lib/portfolio/syncSafety.ts` exist because of a real data loss and must keep holding:

- Never push when the pull failed. A failed pull keeps the local copy and syncs nothing.
- Never push an empty ledger unless this session has seen a non-empty one.
- Never let a cloud copy with no transactions overwrite a local copy that has some.
- Never destroy a redundant copy before the replacement has been read back.

Local snapshots are written to a separate IndexedDB database whenever a change would reduce the transaction count, and can be restored from the portfolio menu. The sync path never writes them.

## Layout

```
src/domain/       schemas for the plan and the portfolio (zod)
src/engine/       the forecast projection and, under portfolio/, the ledger engine
src/lib/          importers, feeds, sync, formatting
src/store/        zustand stores and the sync hooks
src/components/   UI, with portfolio/ for the tracker
src/app/          routes and API handlers
```

The engine directories are pure and fully unit-tested; anything that touches the browser, a feed, or Supabase lives outside them.
