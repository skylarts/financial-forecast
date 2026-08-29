import { requireSchwabAccess } from "@/lib/portfolio/schwabGuard";
import { fetchSchwabAccounts } from "@/lib/portfolio/schwabTransactions";

/**
 * The accounts a connected Schwab login can see, numbers masked.
 *
 * 404 rather than 500 when there is no connection: not being connected is a
 * supported resting state, not a failure, and the caller's move is the same
 * either way -- offer the sign-in.
 */
export async function GET() {
  const guard = await requireSchwabAccess();
  if (!guard.ok) return guard.response;

  const accounts = await fetchSchwabAccounts();
  if (!accounts) {
    return Response.json({ error: "not_connected" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ accounts }, { headers: { "Cache-Control": "no-store" } });
}
