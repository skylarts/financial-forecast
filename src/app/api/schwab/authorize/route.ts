import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl, schwabConfigured, STATE_COOKIE } from "@/lib/portfolio/schwabAuth";

/**
 * Starts the Schwab consent flow.
 *
 * A human has to walk through this roughly weekly for as long as the
 * integration is wanted: Schwab's refresh token dies after seven days and
 * cannot be renewed without a login. There is no unattended alternative.
 */

export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  if (!schwabConfigured()) {
    return NextResponse.redirect(`${origin}/portfolio?schwab=unconfigured`);
  }

  // A single-use value echoed back by Schwab and compared on return, so a
  // callback the user never initiated cannot bind someone else's brokerage
  // to this install.
  const state = randomBytes(16).toString("hex");
  (await cookies()).set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/api/schwab",
    maxAge: 10 * 60,
  });

  return NextResponse.redirect(authorizeUrl(state));
}
