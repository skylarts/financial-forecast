import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appOrigin, authorizeUrl, STATE_COOKIE } from "@/lib/portfolio/schwabAuth";
import { requireSchwabAccess } from "@/lib/portfolio/schwabGuard";

/**
 * Starts the Schwab consent flow.
 *
 * A human has to walk through this roughly weekly for as long as the
 * integration is wanted: Schwab's refresh token dies after seven days and
 * cannot be renewed without a login. There is no unattended alternative.
 */

export async function GET(request: Request) {
  const origin = appOrigin(request.url);

  // A connection has to belong to someone. Starting the flow while signed out
  // on a deployment would mint a credential with nowhere to put it.
  const guard = await requireSchwabAccess();
  if (!guard.ok) return NextResponse.redirect(`${origin}/portfolio?schwab=sign_in_required`);

  // Resolved per caller: their own registered Schwab app, or the deployment's
  // where the operator lends it out. Null means this person has no application
  // to connect through and the answer is the settings form, not a retry.
  const state = randomBytes(16).toString("hex");
  const target = await authorizeUrl(state);
  if (!target) return NextResponse.redirect(`${origin}/portfolio?schwab=unconfigured`);

  // A single-use value echoed back by Schwab and compared on return, so a
  // callback the user never initiated cannot bind someone else's brokerage
  // to this install.
  (await cookies()).set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/api/schwab",
    maxAge: 10 * 60,
  });

  return NextResponse.redirect(target);
}
