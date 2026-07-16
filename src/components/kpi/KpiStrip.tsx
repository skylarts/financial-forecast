import type { ProjectionResult, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";

export function KpiStrip({
  kpis,
  years,
  dollarMode,
}: {
  kpis: ProjectionResult["kpis"];
  years: YearSnapshot[];
  dollarMode: DollarMode;
}) {
  const real = dollarMode === "real";
  const eoy = real ? kpis.netWorthEndOfYear1Real : kpis.netWorthEndOfYear1;
  const atRetirement = real ? kpis.netWorthAtRetirementReal : kpis.netWorthAtRetirement;
  const lastYear = years[years.length - 1];
  const atEnd = lastYear ? (real ? lastYear.netWorthReal : lastYear.netWorthNominal) : 0;

  const cards: { label: string; value: string }[] = [
    { label: "Net worth (EOY)", value: formatMoney(eoy) },
    {
      label: "Net worth at retirement",
      value: atRetirement !== null ? formatMoney(atRetirement) : "—",
    },
    { label: "Retirement age", value: kpis.retirementAge !== null ? String(kpis.retirementAge) : "—" },
    { label: "Net worth at end", value: formatMoney(atEnd) },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-border bg-panel p-4">
          <div className="text-xs text-dim">{card.label}</div>
          <div className="mt-1 text-2xl font-bold">{card.value}</div>
        </div>
      ))}
    </div>
  );
}
