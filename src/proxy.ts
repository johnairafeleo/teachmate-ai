import type { NextRequest } from "next/server";

import { isAuthPagePath, isProtectedPath } from "@/lib/auth/redirect";
import { redirectPreservingSession, updateSession } from "@/lib/supabase/proxy";

/**
 * Next.js 16 Proxy (formerly middleware; runs on the Node.js runtime).
 *
 * 1. Refreshes the Supabase session cookie.
 * 2. Optimistic redirects only (UX, not security): signed-out visitors leave /dashboard for
 *    /login, signed-in teachers skip /login and /signup. Real authorization happens in the DAL
 *    (src/lib/auth/dal.ts) on every page and Server Action, and in RLS.
 */
export async function proxy(request: NextRequest) {
  const { response, session } = await updateSession(request);

  // Never redirect Server Action POSTs or other non-navigations; the action itself re-checks.
  if (request.method !== "GET" && request.method !== "HEAD") return response;

  const { pathname, search } = request.nextUrl;

  if (isProtectedPath(pathname) && (session === "none" || session === "invalid")) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    if (session === "invalid") login.searchParams.set("notice", "session_expired");
    return redirectPreservingSession(response, login);
  }

  if (isAuthPagePath(pathname) && session === "valid") {
    return redirectPreservingSession(response, new URL("/dashboard", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next.js internals and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
