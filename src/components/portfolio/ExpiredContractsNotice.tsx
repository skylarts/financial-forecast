"use client";

import { formatOptionSymbol, type TransactionType } from "@/domain/portfolio";
import type { ExpiredContract } from "@/engine/portfolio/expiredContracts";
import { price as formatPrice, shortDate } from "@/lib/portfolio/format";

interface ExpiredContractsNoticeProps {
  contracts: ExpiredContract[];
  /** Records the closing event for one contract, in full. */
  onRecord: (contract: ExpiredContract, type: TransactionType) => void;
}

/** Plain-language account of what the strike and the latest quote imply. */
function verdict(contract: ExpiredContract): string {
  const { outcome, right, strike, underlying, underlyingPrice } = contract;
  if (outcome === "unknown") {
    return `No quote for ${underlying}, so whether this finished in the money is unknown — pick the one that matches your statement.`;
  }

  const quote = formatPrice(underlyingPrice ?? 0);
  const relation = right === "call" ? "above" : "below";
  const inverse = right === "call" ? "below" : "above";

  return outcome === "settled"
    ? `${underlying} is at ${quote}, ${relation} the ${formatPrice(strike)} strike — in the money, so this was almost certainly ${
        contract.side === "long" ? "exercised" : "assigned"
      } rather than left to lapse.`
    : `${underlying} is at ${quote}, ${inverse} the ${formatPrice(strike)} strike — out of the money, so this expired worthless.`;
}

/** The actions offered, most-likely first so the safe click is the nearest one. */
function actionsFor(contract: ExpiredContract): { type: TransactionType; label: string }[] {
  const settled: { type: TransactionType; label: string } =
    contract.side === "long"
      ? { type: "option_exercise", label: "Exercised" }
      : { type: "option_assign", label: "Assigned" };
  const worthless = { type: "option_expire" as TransactionType, label: "Expired worthless" };

  return contract.suggestedType === "option_expire" ? [worthless, settled] : [settled, worthless];
}

/**
 * Flags contracts left open past their expiry.
 *
 * A contract cannot outlive its expiry date, so one still on the books means
 * the closing event was never recorded -- and until it is, the premium sits in
 * the portfolio as an unrealized figure that will never resolve.
 *
 * The action is offered rather than applied. Whether a contract expired
 * worthless or was exercised is the difference between realizing the premium
 * now and rolling it into a stock basis, so this suggests the likely answer,
 * shows the reasoning, and leaves the choice with the person holding the
 * statement. The suggestion leans on today's quote, not the price on expiry
 * day, which is good enough to rank two buttons and not good enough to act on
 * unasked.
 */
export function ExpiredContractsNotice({ contracts, onRecord }: ExpiredContractsNoticeProps) {
  if (contracts.length === 0) return null;

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/10 p-3">
      <div className="mb-2 text-[12.5px] font-medium text-foreground">
        {contracts.length === 1
          ? "1 option contract is still open past its expiry"
          : `${contracts.length} option contracts are still open past their expiry`}
        <span className="ml-2 font-normal text-dim-2">
          Their value is stuck as unrealized until the closing event is recorded.
        </span>
      </div>

      <div className="space-y-1.5">
        {contracts.map((contract) => (
          <div
            key={contract.holdingKey}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-panel px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-foreground">
              {formatOptionSymbol(contract.symbol)}
            </span>
            <span className="text-dim-2">
              {contract.quantity} {contract.quantity === 1 ? "contract" : "contracts"}
              {contract.side === "short" ? " written" : " held"} · expired{" "}
              {shortDate(contract.expiry)}
            </span>
            <span className="basis-full text-dim">{verdict(contract)}</span>
            <div className="flex gap-1.5">
              {actionsFor(contract).map((action, index) => (
                <button
                  key={action.type}
                  onClick={() => onRecord(contract, action.type)}
                  className={
                    index === 0
                      ? "rounded border border-accent px-2 py-0.5 text-[11.5px] text-accent hover:bg-accent hover:text-panel"
                      : "rounded border border-border px-2 py-0.5 text-[11.5px] text-dim hover:text-foreground"
                  }
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
