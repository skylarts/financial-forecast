"use client";

import type { Holding } from "@/engine/portfolio/metrics";
import { money, percent, price, shares, shortDate, toneFor } from "@/lib/portfolio/format";

const HEAD = "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

export function HoldingsTable({
  holdings,
  accountNames,
  showAccount,
  onSelect,
}: {
  holdings: Holding[];
  accountNames: Map<string, string>;
  showAccount: boolean;
  onSelect: (holding: Holding) => void;
}) {
  if (holdings.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-[13px] text-dim">
        No open positions yet. Import a transaction history or add a buy to get started.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className={`${HEAD} text-left`}>Holding</th>
            {showAccount && <th className={`${HEAD} text-left`}>Account</th>}
            <th className={`${HEAD} text-right`}>Shares</th>
            <th className={`${HEAD} text-right`}>Avg cost</th>
            <th className={`${HEAD} text-right`}>Price</th>
            <th className={`${HEAD} text-right`}>Value</th>
            <th className={`${HEAD} text-right`}>Weight</th>
            <th className={`${HEAD} text-right`}>Unrealized</th>
            <th className={`${HEAD} text-right`}>Return</th>
            <th className={`${HEAD} text-right`}>Annualized</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding) => (
            <tr
              key={holding.key}
              onClick={() => onSelect(holding)}
              className="cursor-pointer border-b border-border-soft transition-colors hover:bg-panel-2"
            >
              <td className={`${CELL} text-left`}>
                <span className="font-semibold text-foreground">{holding.symbol}</span>
                {holding.name !== holding.symbol && (
                  <span className="ml-2 text-[11.5px] text-dim-2">{holding.name}</span>
                )}
              </td>
              {showAccount && (
                <td className={`${CELL} text-left text-dim`}>
                  {accountNames.get(holding.accountId) ?? "—"}
                </td>
              )}
              <td className={`${CELL} text-right text-dim`}>{shares(holding.quantity)}</td>
              <td className={`${CELL} text-right text-dim`}>{price(holding.avgCostPerShare)}</td>
              <td className={`${CELL} text-right`}>
                {holding.price === null ? (
                  <span className="text-dim-2" title="No quote available — valued at cost basis.">
                    no quote
                  </span>
                ) : (
                  <span className="text-foreground" title={holding.priceDate ? `As of ${shortDate(holding.priceDate)}` : undefined}>
                    {price(holding.price)}
                  </span>
                )}
              </td>
              <td className={`${CELL} text-right font-semibold text-foreground`}>
                {money(holding.marketValue)}
              </td>
              <td className={`${CELL} text-right text-dim`}>{(holding.weight * 100).toFixed(1)}%</td>
              <td className={`${CELL} text-right ${toneFor(holding.unrealizedGain)}`}>
                {money(holding.unrealizedGain)}
              </td>
              <td className={`${CELL} text-right ${toneFor(holding.unrealizedGain)}`}>
                {percent(holding.unrealizedGainPct)}
              </td>
              <td className={`${CELL} text-right ${toneFor(holding.irr ?? 0)}`}>
                {percent(holding.irr)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
