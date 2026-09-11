"use client";

import { Btn } from "@/components/ui/controls";

/**
 * What a brand-new tracker shows instead of an empty table.
 *
 * The holdings table used to open on "No open positions match. Clear the
 * filters, import a transaction history, or add a buy." -- three verbs and
 * no way to do any of them from where you were reading, with the sample
 * ledger buried in the overflow menu. The three real starting points are
 * buttons here, in the order most people arrive with: a file from the
 * broker, the broker itself, or nothing yet and a look around first.
 *
 * Shown only while the ledger is genuinely empty. The moment a single row
 * exists the ordinary table and its filters take over, so a filtered-down
 * view that happens to show nothing keeps its own, different message.
 */
export function EmptyPortfolio({
  onImport,
  onConnectSchwab,
  onLoadDemo,
}: {
  onImport: () => void;
  onConnectSchwab: () => void;
  onLoadDemo: () => void;
}) {
  return (
    <section
      aria-label="Get started"
      className="mx-3 my-6 rounded-lg border border-border bg-panel px-5 py-8 text-center sm:mx-6"
    >
      <h2 className="text-[15px] font-semibold text-foreground">Nothing tracked yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-dim">
        Everything here is replayed from transactions: holdings, tax lots, cash, and every
        performance figure. Start with the transactions and the rest follows.
      </p>
      <div className="mt-5 flex flex-wrap items-stretch justify-center gap-3">
        <Start
          title="Import a file"
          body="A transactions download from Schwab or Fidelity, a workplace plan export, or any CSV."
          action={<Btn variant="primary" onClick={onImport}>Import transactions</Btn>}
        />
        <Start
          title="Connect Schwab"
          body="Sign in once and pull an account's history straight into the import review."
          action={<Btn onClick={onConnectSchwab}>Schwab connection</Btn>}
        />
        <Start
          title="Look around first"
          body="A fictional household's ledger, to see what the tracker does before trusting it with yours."
          action={<Btn onClick={onLoadDemo}>Load sample data</Btn>}
        />
      </div>
    </section>
  );
}

function Start({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex w-full max-w-[16rem] flex-col items-center gap-2 rounded-md border border-border-soft bg-panel-2/40 px-4 py-4">
      <div className="text-[13px] font-semibold text-foreground">{title}</div>
      <p className="flex-1 text-[11.5px] text-dim">{body}</p>
      {action}
    </div>
  );
}
