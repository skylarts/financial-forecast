import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appOrigin, exchangeCode, STATE_COOKIE } from "@/lib/portfolio/schwabAuth";
import { requireSchwabAccess } from "@/lib/portfolio/schwabGuard";

/**
 * Where Schwab sends the browser back with a one-time code.
 *
 * Every failure lands the user back on the portfolio with a reason in the
 * query string rather than on an error page: not being connected to Schwab is
 * a supported state, and the prices keep coming from the fallback feed
 * throughout.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = appOrigin(request.url);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);

  const back = (outcome: string) => NextResponse.redirect(`${origin}/portfolio?schwab=${outcome}`);

  const guard = await requireSchwabAccess();
  if (!guard.ok) return back("sign_in_required");

  // Schwab reports a refusal by redirecting here with an error rather than a
  // code -- most often the user simply declining on the consent screen.
  if (searchParams.get("error")) return back("denied");

  const state = searchParams.get("state");
  if (!expected || !state || state !== expected) return back("state_mismatch");

  const code = searchParams.get("code");
  if (!code) return back("failed");

  return back((await exchangeCode(code)) ? "connected" : "failed");
}
