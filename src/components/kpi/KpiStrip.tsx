import type { ProjectionResult, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";

interface Card {
  label: string;
  value: string;
  compareValue: string | null;
  delta: string | null;
  deltaPositive: boolean | null;
}

export function KpiStrip({
  kpis,
  years,
  dollarMode,
  isFullRange,
  compareKpis = null,
  compareYears = [],
  compareName = null,
}: {
  kpis: ProjectionResult["kpis"];
  years: YearSnapshot[];
  dollarMode: DollarMode;
  isFullRange: boolean;
  compareKpis?: ProjectionResult["kpis"] | null;
  compareYears?: YearSnapshot[];
  compareName?: string | null;
}) {
  const real = dollarMode === "real";
  const eoy = real ? kpis.netWorthEndOfYear1Real : kpis.netWorthEndOfYear1;
  const atRetirement = real ? kpis.netWorthAtRetirementReal : kpis.netWorthAtRetirement;
  const lastYear = years[years.length - 1];
  const atEnd = lastYear ? (real ? lastYear.netWorthReal : lastYear.netWorthNominal) : 0;

  const cmpEoy = compareKpis ? (real ? compareKpis.netWorthEndOfYear1Real : compareKpis.netWorthEndOfYear1) : null;
  const cmpAtRetirement = compareKpis
    ? real
      ? compareKpis.netWorthAtRetirementReal
      : compareKpis.netWorthAtRetirement
    : null;
  const cmpLastYear = compareYears[compareYears.length - 1];
  const cmpAtEnd = compareKpis && cmpLastYear ? (real ? cmpLastYear.netWorthReal : cmpLastYear.netWorthNominal) : null;

  const moneyDelta = (a: number, b: number | null) => (b === null ? null : formatMoney(a - b));
  const ageDelta = (a: number | null, b: number | null) =>
    a === null || b === null ? null : `${a - b >= 0 ? "+" : ""}${a - b}`;

  const cards: Card[] = [
    {
      label: "Net worth (EOY)",
      value: formatMoney(eoy),
      compareValue: compareKpis ? formatMoney(cmpEoy ?? 0) : null,
      delta: moneyDelta(eoy, cmpEoy),
      deltaPositive: compareKpis ? eoy - (cmpEoy ?? 0) >= 0 : null,
    },
    {
      label: "Net worth at retirement",
      value: atRetirement !== null ? formatMoney(atRetirement) : "—",
      compareValue: compareKpis ? (cmpAtRetirement !== null ? formatMoney(cmpAtRetirement) : "—") : null,
      delta: atRetirement !== null ? moneyDelta(atRetirement, cmpAtRetirement) : null,
      deltaPositive:
        compareKpis && atRetirement !== null && cmpAtRetirement !== null ? atRetirement - cmpAtRetirement >= 0 : null,
    },
    {
      label: "Retirement age",
      value: kpis.retirementAge !== null ? String(kpis.retirementAge) : "—",
      compareValue: compareKpis ? (compareKpis.retirementAge !== null ? String(compareKpis.retirementAge) : "—") : null,
      // A lower retirement age is the "better" outcome, so the delta's color sense is inverted vs. net worth.
      delta: ageDelta(kpis.retirementAge, compareKpis?.retirementAge ?? null),
      deltaPositive:
        compareKpis && kpis.retirementAge !== null && compareKpis.retirementAge !== null
          ? kpis.retirementAge - compareKpis.retirementAge <= 0
          : null,
    },
    {
      label: isFullRange ? "Net worth at end" : `Net worth in ${lastYear?.year ?? ""}`,
      value: formatMoney(atEnd),
      compareValue: compareKpis ? formatMoney(cmpAtEnd ?? 0) : null,
      delta: moneyDelta(atEnd, cmpAtEnd),
      deltaPositive: compareKpis ? atEnd - (cmpAtEnd ?? 0) >= 0 : null,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-border bg-panel p-4">
          <div className="text-xs text-dim">{card.label}</div>
          {card.compareValue === null ? (
            <div className="mt-1 text-2xl font-bold">{card.value}</div>
          ) : (
            <div className="mt-1 flex items-stretch gap-3">
              <div className="text-2xl font-bold">{card.value}</div>
              <div className="w-px shrink-0 bg-border" />
              <div>
                <div className="text-sm font-medium text-dim">{card.compareValue}</div>
                {card.delta && (
                  <div className={`text-xs font-semibold ${card.deltaPositive ? "text-positive" : "text-negative"}`}>
                    {card.delta}
                  </div>
                )}
                {compareName && <div className="text-[10px] text-dim/70">vs {compareName}</div>}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
