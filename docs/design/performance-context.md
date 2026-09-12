# Performance context: drawdown, contributions, volatility

Status: proposal. Nothing here is built.

## The gap

The Performance tab draws the time-weighted growth of $10,000 against a benchmark and prints a return for each window. Two things a person looking at that chart cannot answer:

1. **How bad did it get?** A line that ends up 40% shows nothing about the 25% hole it climbed out of in between. Max drawdown is the single most-asked risk question and it is absent.
2. **Why do my two return figures disagree?** The summary card shows a time-weighted return and a money-weighted one (the ledger's own IRR). On this household's brokerage they have differed by 20 points. The whole difference is *when money went in*, and nothing on the page shows when that was. The series already knows: every point carries that day's external flow.

Volatility is the third figure people expect beside a drawdown. It is one pass over the series, so it comes along.

## What the screen shows

**A second row of three tiles** under "Your return / Annualized / vs SPY":

| Tile | Reads | Hover |
| --- | --- | --- |
| Max drawdown | `-23.4%` | "Peak 02/19/2025 to trough 04/08/2025, recovered 07/02/2025" or "not yet recovered" |
| Volatility | `18.2%` | "Annualized standard deviation of daily returns over this window" |
| Net contributions | `+$14,200` | "$18,400 put in, $4,200 taken out, in this window. Time-weighted returns ignore this; money-weighted returns do not." |

When a benchmark is loaded, the drawdown and volatility tiles carry the benchmark's own figure as a second, dimmer line (`SPY -18.9%`), so the portfolio's risk reads against something.

**On the chart**, two additions, both off by default and switched on from the legend row:

- **Contributions** draws the day's external flows as thin bars on a right-hand dollar axis, positive up and negative down, in a muted accent. On windows longer than three months the bars are bucketed to the week, and beyond a year to the month, so a five-year chart does not become a picket fence. The tooltip gains a line: "Contributions this month +$1,200".
- **Drawdown** shades the span from the peak to the recovery (or to the window's end) behind the portfolio line, so the tile's dates are visible on the picture.

On a phone the toggles default off as they do on desktop; nothing changes in the layout.

## What the engine needs

One new pure module, `src/engine/portfolio/riskStats.ts`, reading the `PerformancePoint[]` a series already produces:

```ts
maxDrawdown(points): { depth: number; peak: ISODate; trough: ISODate; recovered: ISODate | null } | null
volatility(points): number | null          // annualized stdev of ln(index_t / index_t-1), sqrt(252)
netFlows(points): { in: number; out: number; net: number }
bucketFlows(points, grain: "day" | "week" | "month"): { date: ISODate; flow: number }[]
```

Drawdown walks the index once keeping the running peak. Volatility is one pass for mean and variance. Flows are sums. None of this touches the ledger, the lot engine, or the caches; it is computed after the series is built, per window, the same way `totalReturn` is today.

Benchmarks already arrive as indexed point series, so the same functions run over them unchanged.

## Files touched

- `src/engine/portfolio/riskStats.ts` and its test (new).
- `src/components/portfolio/PerformancePanel.tsx`: the tile row, the two legend toggles, `LineChart` becomes `ComposedChart` with a `Bar` on a second `YAxis` and a `ReferenceArea`, the tooltip gains the flow line.
- Nothing in the store, the schema, or the importer.

## What could go wrong

- **Days with no price.** The series has a point per trading day; a deposit that posts on a Saturday is folded into the next trading day by the engine already, so no flow is lost. Worth a test.
- **Unpriced transfers.** A security transferred in without a price history counts as zero flow today (`externalFlowFor` returns 0). The contributions tile will understate by that amount, exactly as the time-weighted series already does. The tile's hover will say "transfers the feed could not price are not counted" when any exist in the window.
- **Two y-axes** read badly if the bar axis is not clearly secondary. The bars get no gridlines and a right-side axis with three ticks at most.
- **Volatility on a short window** (one month, twenty points) is noise. The tile shows a dash under sixty points and says why on hover.
- **Recovery date** on an ongoing drawdown is null and the tile must say "not yet recovered", never blank.

## Not in this proposal

- Sharpe or Sortino ratios: they need a risk-free rate the app has no source for.
- Per-position drawdown in the position drawer: the same function would work on a price series, but the ask was the portfolio chart.

## Size

One PR. Roughly 150 lines of engine plus tests, 120 lines of panel changes.
