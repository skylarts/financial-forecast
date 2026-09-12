"use client";

import { Btn } from "@/components/ui/controls";

/**
 * What a brand-new forecast shows instead of a dashboard full of zeros.
 * Mirrors the tracker's empty state: the real starting points are buttons
 * here, in the order most people arrive with.
 *
 * Shown only while no scenario holds anything a person typed. The moment an
 * account, income, expense, or event exists the ordinary views take over.
 */
export function EmptyForecast({
  onSetUp,
  onRestore,
  onLoadSample,
}: {
  onSetUp: () => void;
  onRestore: () => void;
  onLoadSample: () => void;
}) {
  return (
    <section aria-label="Get started" className="mx-3 my-6 rounded-lg border border-border bg-panel px-5 py-8 text-center sm:mx-6">
      <h2 className="text-[15px] font-semibold text-foreground">Nothing planned yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-dim">
        The forecast projects your household year by year from what you tell it: who you are, what you own, what comes in,
        and what goes out. Start with those and the rest follows.
      </p>
      <div className="mt-5 flex flex-wrap items-stretch justify-center gap-3">
        <Start
          title="Set up your plan"
          body="A short guided walk through your household, accounts, income, and expenses. Everything can be changed later."
          action={
            <Btn variant="primary" onClick={onSetUp}>
              Start the setup guide
            </Btn>
          }
        />
        <Start
          title="Restore a backup"
          body="A plan saved from this app on another browser or device, as a file."
          action={<Btn onClick={onRestore}>Restore from a file</Btn>}
        />
        <Start
          title="Look around first"
          body="A fictional household's plan, to see what the forecast does before trusting it with yours."
          action={<Btn onClick={onLoadSample}>Load sample plan</Btn>}
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
