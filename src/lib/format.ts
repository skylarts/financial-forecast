/** Whether dollar figures are shown in future (nominal) or today's (real) dollars. */
export type DollarMode = "nominal" | "real";

export function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function formatPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function ageOn(birthDate: string, onDate: string): number {
  const b = new Date(birthDate + "T00:00:00");
  const d = new Date(onDate + "T00:00:00");
  let years = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) {
    years -= 1;
  }
  return years;
}
