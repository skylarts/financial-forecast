import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  // Refreshes the auth session cookie (if expired) on every request so
  // client components always see an up-to-date session.
  await supabase.auth.getUser();

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
