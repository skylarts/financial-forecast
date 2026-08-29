import { fetchSchwabTransactions, MAX_RANGE_DAYS } from "@/lib/portfolio/schwabTransactions";

/** Transactions for one account over a window, as ledger-shaped rows. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const account = (params.get("account") ?? "").trim();
  if (!account) {
    return Response.json({ error: "account required" }, { status: 400 });
  }

  // Schwab serves at most a year per request, and asking for more returns an
  // error rather than a truncated window -- so the ceiling is applied here
  // instead of being discovered as a failed sync.
  const requested = Number(params.get("days") ?? "90");
  const days = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), MAX_RANGE_DAYS)
    : 90;

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const result = await fetchSchwabTransactions(account, from, to);
  if (!result) {
    return Response.json({ error: "not_connected" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  return Response.json(
    { ...result, days, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
