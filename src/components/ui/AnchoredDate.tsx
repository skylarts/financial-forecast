"use client";

import { useEffect } from "react";
import type React from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import {
  ANCHOR_OFFSET_OPTIONS,
  anchorLabel,
  resolveAnchor,
  resolveEndAnchor,
  retirementDateOf,
  type DateAnchor,
  type ISODate,
  type Person,
} from "@/domain";
import { inputClass } from "./formFields";

/**
 * A date field that can either be typed in or follow someone's retirement.
 *
 * Linked, the date box goes read-only and two small pickers take over: whose
 * retirement, and how far from it. The resolved date is still written into the
 * same form field (via `onResolve`), so the submit path, the validation and
 * everything downstream stay exactly as they were for a typed date -- the link
 * decides what the date IS, it does not become a second kind of date.
 */
export function AnchoredDateInput({
  reg,
  controlled,
  anchor,
  onAnchorChange,
  onResolve,
  people,
  kind,
  defaultPersonId,
}: {
  /** react-hook-form registration, for the drawers. Omit when passing `controlled`. */
  reg?: UseFormRegisterReturn;
  /** Plain controlled value, for editors that don't use react-hook-form (the routing rows). */
  controlled?: { value: string; onChange: (value: string) => void };
  anchor: DateAnchor | null;
  onAnchorChange: (anchor: DateAnchor | null) => void;
  /** Called with the date the link resolves to, so the caller can write it into the form. */
  onResolve: (date: ISODate) => void;
  people: readonly Person[];
  /** An end date resolves to the day BEFORE the milestone; a start date to the day itself. */
  kind: "start" | "end";
  /** Who the link points at when it is first switched on (the item's owner, when it has one). */
  defaultPersonId?: string | null;
}) {
  const resolved = anchor ? (kind === "end" ? resolveEndAnchor(anchor, people) : resolveAnchor(anchor, people)) : null;
  // One shape for the <input> whichever way the caller drives it.
  const inputProps = reg ?? {
    value: controlled?.value ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => controlled?.onChange(e.target.value),
  };
  // Someone modelled as never retiring has no date to follow, so they are not
  // offered as a choice -- linking to them would silently resolve to nothing.
  const retiring = people.filter((p) => retirementDateOf(p) !== null);

  // Push the resolved date into the form field whenever the link or the
  // retirement it follows moves. Mirrors how a claiming age already fills in a
  // benefit's start date -- the date field stays the one thing that is saved.
  useEffect(() => {
    if (resolved) onResolve(resolved);
    // onResolve is a fresh closure each render; the resolved date is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  if (!anchor) {
    if (retiring.length === 0) return <input {...inputProps} type="date" className={inputClass} />;
    return (
      <>
        <input {...inputProps} type="date" className={inputClass} />
        <button
          type="button"
          onClick={() =>
            onAnchorChange({
              personId: retiring.some((p) => p.id === defaultPersonId) ? defaultPersonId! : retiring[0].id,
              point: "retirement",
              offsetMonths: 0,
            })
          }
          className="self-start text-[11px] text-dim underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Follow a retirement date instead
        </button>
      </>
    );
  }

  const missingPerson = !retiring.some((p) => p.id === anchor.personId);

  return (
    <>
      <input {...inputProps} type="date" readOnly tabIndex={-1} className={`${inputClass} cursor-not-allowed opacity-60`} />
      <div className="flex flex-col gap-1 rounded-md border border-accent/40 bg-accent/5 p-1.5">
        {/* Stacked, not side by side: these sit inside a half-width column in
            a two-date FieldRow, where two selects on one line truncate their
            own labels ("At retirem..."). */}
        <div className="flex flex-col gap-1">
          <select
            value={String(anchor.offsetMonths)}
            onChange={(e) => onAnchorChange({ ...anchor, offsetMonths: Number(e.target.value) })}
            className={`${inputClass} px-1 py-1 text-xs`}
          >
            {/* A saved offset that isn't one of the round choices (hand-edited
                JSON, or a list that changed) still shows, instead of silently
                snapping the plan to a different date on the next save. */}
            {!ANCHOR_OFFSET_OPTIONS.some((o) => o.value === anchor.offsetMonths) && (
              <option value={anchor.offsetMonths}>{`${anchor.offsetMonths} months`}</option>
            )}
            {ANCHOR_OFFSET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={anchor.personId}
            onChange={(e) => onAnchorChange({ ...anchor, personId: e.target.value })}
            className={`${inputClass} px-1 py-1 text-xs`}
          >
            {missingPerson && <option value={anchor.personId}>(no longer retiring)</option>}
            {retiring.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] text-dim-2">
            {resolved ? (
              <>
                {kind === "end" ? "Runs through " : "Starts "}
                <span className="text-foreground">{resolved}</span>
                {kind === "end" ? ", the day before it" : ""}
              </>
            ) : (
              "That person no longer retires in this plan."
            )}
          </span>
          <button
            type="button"
            onClick={() => onAnchorChange(null)}
            className="shrink-0 text-[11px] text-dim underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Unlink
          </button>
        </div>
      </div>
    </>
  );
}

/** The chip the timeline and the drawers show on a date that follows a retirement. */
export function AnchorChip({ anchor, people }: { anchor: DateAnchor; people: readonly Person[] }) {
  return (
    <span className="whitespace-nowrap rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
      ↳ {anchorLabel(anchor, people)}
    </span>
  );
}
