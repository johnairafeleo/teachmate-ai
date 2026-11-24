import "server-only";

import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { readPublicEnv } from "@/lib/env/public";

/** Supabase session cookies: `sb-<project>-auth-token`, optionally chunked (`.0`, `.1`, …). */
const SESSION_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;
/** Also present during a PKCE sign-in/sign-up flow, before any session exists. */
const VERIFIER_COOKIE = /^sb-.+-auth-token-code-verifier(?:\.\d+)?$/;

let warnedAboutConfig = false;

/**
 * - `none`: no session cookie (a visitor).
 * - `valid`: the session verified (and was refreshed if needed).
 * - `invalid`: a session cookie existed but could not be verified or refreshed (expired/revoked).
 * - `unknown`: Supabase misconfigured or unreachable; callers must not treat this as signed out.
 */
export type SessionState = "none" | "valid" | "invalid" | "unknown";

/**
 * Refreshes the Supabase session cookie for the current request.
 *
 * Server Components cannot write cookies, so the proxy is where expired access tokens are
 * refreshed and written back. The returned state is only good for optimistic redirects: every
 * page, Server Action and Route Handler must still verify the user through `src/lib/auth/dal.ts`.
 */
export async function updateSession(request: NextRequest): Promise<{ response: NextResponse; session: SessionState }> {
  let response = NextResponse.next({ request });

  const names = request.cookies.getAll().map((cookie) => cookie.name);
  const hasSession = names.some((name) => SESSION_COOKIE.test(name));
  // No Supabase cookies → nothing to refresh. Skips work (and Supabase config) for visitors.
  if (!hasSession && !names.some((name) => VERIFIER_COOKIE.test(name))) {
    return { response, session: "none" };
  }

  const config = readPublicEnv();
  if (!config.ok) {
    // Never take the whole site down for a refresh. Authorization still fails closed elsewhere,
    // because the server client throws on invalid configuration.
    if (!warnedAboutConfig) {
      warnedAboutConfig = true;
      console.error(`[proxy] Supabase session refresh skipped: ${config.message}`);
    }
    return { response, session: "unknown" };
  }

  const supabase = createServerClient(
    config.env.NEXT_PUBLIC_SUPABASE_URL,
    config.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          // Make refreshed tokens visible to Server Components rendering this request…
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          // …and send them to the browser.
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          // Responses that set auth cookies must never be cached by Vercel's CDN or any proxy,
          // or one teacher's session could be served to another.
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    },
  );

  // Do not run other logic between creating the client and getClaims() (Supabase guidance):
  // getClaims() verifies the access token and refreshes it when it is about to expire.
  let session: SessionState;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (data?.claims) session = "valid";
    else if (error && isAuthRetryableFetchError(error)) session = "unknown";
    else session = hasSession ? "invalid" : "none";
  } catch (error) {
    // Network/Auth outage: continue without refreshing. Log no tokens or cookie values.
    console.error("[proxy] Supabase session refresh failed:", error instanceof Error ? error.name : "unknown error");
    session = "unknown";
  }

  return { response, session };
}

/**
 * Redirect while keeping whatever the Supabase client wrote (refreshed or cleared cookies and
 * its no-store headers); otherwise a cleared session cookie would come back on the next request.
 */
export function redirectPreservingSession(from: NextResponse, url: URL): NextResponse {
  const redirect = NextResponse.redirect(url);
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(header);
    if (value) redirect.headers.set(header, value);
  }
  if (!redirect.headers.has("cache-control")) redirect.headers.set("cache-control", "private, no-store");
  return redirect;
}
