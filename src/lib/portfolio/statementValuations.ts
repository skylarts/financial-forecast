import type { StatementValuation } from "@/domain/portfolio/portfolio";

export interface ParsedValuations {
  rows: Omit<StatementValuation, "id" | "accountId">[];
  /** Lines the parser could not read, named so a bad paste is visible. */
  skipped: string[];
}

/** Last day of `YYYY-MM`, which is what a monthly statement is struck on. */
function endOfMonth(month: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  // Day 0 of the next month is the last day of this one.
  const d = new Date(Date.UTC(year, mon, 0));
  return d.toISOString().slice(0, 10);
}

function toDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return endOfMonth(s);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (us !== null) return `${us[3]}-${us[1]}-${us[2]}`;
  return null;
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/[$,]/g, "");
  if (s === "") return null;
  // Accounting parentheses mean negative.
  const neg = /^\((.*)\)$/.exec(s);
  const n = Number(neg === null ? s : neg[1]);
  if (!Number.isFinite(n)) return null;
  return neg === null ? n : -n;
}

function fromRecord(rec: Record<string, unknown>): Omit<StatementValuation, "id" | "accountId"> | null {
  const date = toDate(rec.date ?? rec.month ?? rec.Date ?? rec.Month);
  const value = toNumber(rec.value ?? rec.npv ?? rec.Value ?? rec.NPV);
  if (date === null || value === null) return null;
  return {
    date,
    value,
    contributions: toNumber(rec.contributions ?? rec.contrib ?? rec.Contributions) ?? null,
    income: toNumber(rec.income ?? rec.dividends ?? rec.Income ?? rec.Dividends) ?? null,
    note: typeof rec.note === "string" ? rec.note : "",
  };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Reads period-end account values out of a pasted file.
 *
 * Takes three shapes, because they are the three a statement export arrives in:
 * a JSON object with a `valuations` array (what a portfolio terminal exports),
 * a bare JSON array, or a CSV with a header row. `YYYY-MM` is read as that
 * month's last day -- a monthly statement values the account at the period end,
 * and dating it to the first would place a month of return before it was earned.
 */
export function parseStatementValuations(text: string): ParsedValuations {
  const trimmed = text.trim();
  if (trimmed === "") return { rows: [], skipped: [] };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { rows: [], skipped: ["The file is not valid JSON."] };
    }
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown>)?.valuations ?? []);
    if (!Array.isArray(list)) {
      return { rows: [], skipped: ["No `valuations` array found."] };
    }
    const rows: ParsedValuations["rows"] = [];
    const skipped: string[] = [];
    for (const item of list) {
      const row = typeof item === "object" && item !== null ? fromRecord(item as Record<string, unknown>) : null;
      if (row === null) skipped.push(JSON.stringify(item).slice(0, 80));
      else rows.push(row);
    }
    return { rows, skipped };
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { rows: [], skipped: ["Needs a header row and at least one row."] };
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows: ParsedValuations["rows"] = [];
  const skipped: string[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const rec: Record<string, unknown> = {};
    header.forEach((h, i) => {
      rec[h] = cells[i];
    });
    const row = fromRecord(rec);
    if (row === null) skipped.push(line.slice(0, 80));
    else rows.push(row);
  }
  return { rows, skipped };
}

/**
 * Later rows win on a repeated period end, so re-importing a corrected file
 * replaces what it supersedes instead of leaving two values for one date.
 */
export function dedupeByDate(
  rows: readonly Omit<StatementValuation, "id" | "accountId">[],
): Omit<StatementValuation, "id" | "accountId">[] {
  const byDate = new Map<string, Omit<StatementValuation, "id" | "accountId">>();
  for (const r of rows) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
