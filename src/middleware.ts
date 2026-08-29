import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * How long a page load will wait for the session cookie to be refreshed.
 *
 * This number is the entire point of the file, so it is worth saying why it
 * exists rather than trusting the library to be quick.
 *
 * `supabase.auth.getUser()` refreshes an expired session, and when that
 * request fails in a way that looks transient -- a dropped connection, or any
 * 5xx from the auth server -- `auth-js` retries it with exponential backoff.
 * Its budget for that is `AUTO_REFRESH_TICK_DURATION_MS`, which is **30
 * seconds**. The platform kills a middleware invocation at **25**. So a single
 * unlucky stretch of trouble reaching Supabase does not degrade a page load;
 * it guarantees the whole request is killed, and the visitor gets a 504 rather
 * than the site.
 *
 * That is the failure this app kept hitting, and it is only ever visible to
 * someone signed in: with no session in the cookie there is nothing to
 * refresh, `getUser()` answers locally without a network call at all, and the
 * same routes return in a quarter of a second.
 *
 * Three seconds is far more than a healthy refresh needs and far less than the
 * platform allows. Losing the race costs a slightly stale session cookie for
 * one request, which every consumer already handles -- see below.
 */
const SESSION_REFRESH_BUDGET_MS = 3_000;

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Login is optional -- the app must keep working locally even before
  // Supabase is configured, so skip session refresh rather than crash.
  if (!supabaseUrl || !supabaseAnonKey) return response;

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  /**
   * Refreshes the auth session cookie so client components see a current
   * session -- but never at the cost of the page itself.
   *
   * Giving up here is safe, and that is what makes the deadline the right
   * answer rather than a papered-over timeout. Refreshing the cookie is an
   * optimisation: nothing is authorised on the strength of having happened.
   * Every route handler resolves the session for itself through
   * `createClient`, reading the same cookies and refreshing them if it needs
   * to, and the whole app is built to work signed out -- prices fall back to
   * the public feed, and a Schwab connection reports `signInRequired` rather
   * than failing. A visitor whose refresh was slow sees the page, and the next
   * request picks the session up.
   *
   * The alternative, which is what this replaced, is a blank 504.
   */
  await Promise.race([
    supabase.auth.getUser(),
    new Promise((resolve) => setTimeout(resolve, SESSION_REFRESH_BUDGET_MS)),
  ]);

  return response;
}

/**
 * Pages only.
 *
 * This used to run on every request that was not a static asset, which meant
 * every `/api/*` call too -- and a single portfolio load makes several. Each
 * one arrived here and made its own round trip to Supabase's auth server
 * before the route it was actually for had started, and several of those
 * landed at once, each willing to refresh the same session cookie
 * concurrently. Supabase rotates refresh tokens, so a burst of simultaneous
 * refreshes is also the shape of request that gets sessions revoked out from
 * under a working page.
 *
 * The API routes never needed it. Every one of them resolves the session for
 * itself through `createClient`, which reads the same cookies and can refresh
 * them just as well from a route handler. Excluding them takes an ordinary
 * page load from several session refreshes down to one, and leaves this doing
 * the single job it is for: keeping the cookie fresh across navigations.
 */
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
