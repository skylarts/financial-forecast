"use client";

import { useState } from "react";
import {
  ASSET_CLASS_LABELS,
  assetClassSchema,
  formatOptionSymbol,
  INSTRUMENT_TYPE_LABELS,
  instrumentTypeSchema,
  normalizeThemeTag,
  normalizeThemes,
  type AssetClass,
  type Exposure,
  type InstrumentType,
  type Security,
} from "@/domain/portfolio";
import type { ResolvedProfile } from "@/store/useSecurityProfiles";

/** The class carrying the most weight, so a split holding still has one
 *  answer for "what is this, mainly" -- used by every filter, sort, and
 *  dimension besides the exposure split itself. */
export function primaryAssetClass(exposures: readonly Exposure[]): AssetClass {
  if (exposures.length === 0) return "other";
  return [...exposures].sort((a, b) => b.weight - a.weight)[0].assetClass;
}

function pct(weight: number): number {
  return Math.round(weight * 1000) / 10;
}

/**
 * One symbol's row in the classify-holdings panel: instrument type, its
 * asset-class split, and its theme tags.
 *
 * Exposures are edited as whole percentages that don't have to sum to
 * exactly 100 while you're mid-edit -- `resolveExposures` renormalizes
 * whatever's saved, so a row reading 61/40 still resolves cleanly, and the
 * total shown here is just a nudge toward a clean split, not a hard gate.
 */
export function SecurityEditorRow({
  symbol,
  security,
  profile,
  fetching,
  knownThemes,
  onSave,
}: {
  symbol: string;
  security: Security | undefined;
  profile: ResolvedProfile | undefined;
  /** Still waiting on the feed for this symbol this session. */
  fetching: boolean;
  knownThemes: readonly string[];
  onSave: (security: Security) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [themeDraft, setThemeDraft] = useState("");

  const base = (): Security => {
    if (security) return security;
    return {
      symbol,
      name: profile?.name ?? "",
      assetClass: profile?.assetClass ?? "other",
      assetClassSource: "auto",
      exposures: profile?.exposures ?? [],
      instrumentType: profile?.instrumentType ?? "other",
      instrumentTypeSource: "auto",
      themes: [],
      manualPrice: null,
      manualPriceDate: null,
      lastKnownPrice: null,
      lastKnownPriceDate: null,
    };
  };

  const current = base();
  const exposures: Exposure[] =
    current.exposures.length > 0 ? current.exposures : [{ assetClass: current.assetClass, weight: 1 }];
  const totalPct = Math.round(exposures.reduce((sum, e) => sum + e.weight, 0) * 1000) / 10;
  const isSplit = exposures.length > 1;

  const isClassManual = current.assetClassSource === "manual";
  const isTypeManual = current.instrumentTypeSource === "manual";

  const save = (patch: Partial<Security>) => onSave({ ...current, ...patch });

  const saveExposures = (next: Exposure[]) =>
    save({
      exposures: next,
      assetClass: primaryAssetClass(next),
      assetClassSource: "manual",
    });

  const setWeight = (index: number, rawPct: number) => {
    const next = exposures.map((e, i) => (i === index ? { ...e, weight: Math.max(rawPct, 0) / 100 } : e));
    saveExposures(next);
  };

  const setClassAt = (index: number, assetClass: AssetClass) => {
    const next = exposures.map((e, i) => (i === index ? { ...e, assetClass } : e));
    saveExposures(next);
  };

  const addRow = () => {
    // Defaults to whatever class isn't already spoken for, split evenly with
    // the last row -- a reasonable starting point for the user to correct,
    // not a claim about the fund's real weighting.
    const unused = assetClassSchema.options.find((c) => !exposures.some((e) => e.assetClass === c));
    const last = exposures[exposures.length - 1];
    const half = last.weight / 2;
    const next = [
      ...exposures.slice(0, -1),
      { ...last, weight: half },
      { assetClass: unused ?? "other", weight: half },
    ];
    saveExposures(next);
  };

  const removeRow = (index: number) => {
    if (exposures.length <= 1) return;
    saveExposures(exposures.filter((_, i) => i !== index));
  };

  const revertClassification = () => {
    if (profile) {
      save({
        name: current.name || profile.name,
        assetClass: profile.assetClass,
        assetClassSource: "auto",
        exposures: profile.exposures,
      });
    } else {
      save({ assetClass: "other", assetClassSource: "auto", exposures: [] });
    }
  };

  const revertInstrumentType = () => {
    save({ instrumentType: profile?.instrumentType ?? "other", instrumentTypeSource: "auto" });
  };

  const addTheme = (raw: string) => {
    const tag = normalizeThemeTag(raw);
    if (!tag) return;
    save({ themes: normalizeThemes([...current.themes, tag]) });
    setThemeDraft("");
  };

  const removeTheme = (tag: string) => {
    save({ themes: current.themes.filter((t) => t !== tag) });
  };

  return (
    <div className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          title={formatOptionSymbol(symbol)}
          className="font-semibold text-foreground hover:text-accent"
        >
          {symbol}
        </button>

        <span className="text-dim-2">
          {isSplit
            ? exposures.map((e) => `${ASSET_CLASS_LABELS[e.assetClass]} ${pct(e.weight)}%`).join(" · ")
            : ASSET_CLASS_LABELS[exposures[0].assetClass]}
        </span>

        {isClassManual ? (
          <button
            type="button"
            onClick={revertClassification}
            title={
              profile
                ? `Go back to the feed's answer: ${ASSET_CLASS_LABELS[profile.assetClass]}, ${profile.basis}.`
                : "Go back to the feed's answer -- it'll be re-checked."
            }
            className="text-[11px] text-dim-2 hover:text-foreground"
          >
            ↺
          </button>
        ) : (
          <span
            title={profile ? `Read from the feed: ${profile.basis}.` : fetching ? "Reading from the feed…" : "Read from the feed."}
            className="text-[10px] uppercase tracking-wide text-dim-2"
          >
            auto
          </span>
        )}

        {current.themes.length > 0 && (
          <span className="flex flex-wrap items-center gap-1">
            {current.themes.map((tag) => (
              <span
                key={tag}
                className="rounded bg-panel px-1.5 py-0.5 text-[10.5px] text-dim"
              >
                {tag}
              </span>
            ))}
          </span>
        )}

        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="ml-auto text-[11px] text-dim-2 underline hover:text-foreground"
        >
          {expanded ? "Done" : "Edit"}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <div className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-dim-2">Type</span>
            <select
              value={current.instrumentType}
              onChange={(e) =>
                save({ instrumentType: e.target.value as InstrumentType, instrumentTypeSource: "manual" })
              }
              className="rounded border border-border bg-panel px-1.5 py-0.5 text-[11.5px] text-foreground"
            >
              {instrumentTypeSchema.options.map((t) => (
                <option key={t} value={t}>
                  {INSTRUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            {isTypeManual && (
              <button
                type="button"
                onClick={revertInstrumentType}
                title="Go back to the feed's answer."
                className="text-[11px] text-dim-2 hover:text-foreground"
              >
                ↺
              </button>
            )}
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="w-16 shrink-0 text-dim-2">Split</span>
              <span
                className={`text-[11px] tabular-nums ${
                  Math.abs(totalPct - 100) < 0.5 ? "text-dim-2" : "text-negative"
                }`}
              >
                {totalPct}% total
              </span>
            </div>
            {exposures.map((exposure, i) => (
              <div key={i} className="flex items-center gap-1.5 pl-[70px]">
                <select
                  value={exposure.assetClass}
                  onChange={(e) => setClassAt(i, e.target.value as AssetClass)}
                  className="rounded border border-border bg-panel px-1.5 py-0.5 text-[11.5px] text-foreground"
                >
                  {assetClassSchema.options.map((cls) => (
                    <option key={cls} value={cls}>
                      {ASSET_CLASS_LABELS[cls]}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={pct(exposure.weight)}
                  onChange={(e) => setWeight(i, Number(e.target.value))}
                  className="w-16 rounded border border-border bg-panel px-1.5 py-0.5 text-right text-[11.5px] text-foreground tabular-nums"
                />
                <span className="text-dim-2">%</span>
                {exposures.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    title="Remove this class"
                    className="text-dim-2 hover:text-negative"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {exposures.length < assetClassSchema.options.length && (
              <button
                type="button"
                onClick={addRow}
                className="ml-[70px] text-[11px] text-dim-2 underline hover:text-foreground"
              >
                + Split across another class
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-dim-2">Themes</span>
            <div className="flex flex-1 flex-wrap items-center gap-1">
              {current.themes.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1 rounded bg-panel px-1.5 py-0.5 text-[11px] text-foreground"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTheme(tag)}
                    className="text-dim-2 hover:text-negative"
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                value={themeDraft}
                onChange={(e) => setThemeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTheme(themeDraft);
                  }
                }}
                onBlur={() => addTheme(themeDraft)}
                placeholder="Add a tag, press Enter"
                list={`themes-${symbol}`}
                className="w-32 rounded border border-border bg-panel px-1.5 py-0.5 text-[11.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
              />
              <datalist id={`themes-${symbol}`}>
                {knownThemes
                  .filter((t) => !current.themes.includes(t))
                  .map((t) => (
                    <option key={t} value={t} />
                  ))}
              </datalist>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
