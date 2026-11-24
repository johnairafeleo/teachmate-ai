import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";

import { getPublicEnv } from "@/lib/env/public";
import { fetchWithTimeout } from "@/lib/supabase/fetch-timeout";

/**
 * User-scoped Supabase client for Server Components, Server Actions and Route Handlers.
 * Uses the publishable key and the request's session cookies, so Row Level Security applies.
 *
 * - Create a new client per request; never share one across requests.
 * - Reading `cookies()` is request data: with Cache Components, call this inside a <Suspense>
 *   boundary, never inside a `use cache` scope.
 * - Identity must come from `supabase.auth.getClaims()` (or `getUser()` for destructive actions),
 *   never from `getSession()`, which is not verified on the server.
 */
export async function createClient() {
  // Always request-time. cookies() alone still allows a runtime prefetch prerender, where the
  // auth client's clock reads (token expiry) are rejected; a session must never be prerendered.
  await connection();
  const env = getPublicEnv();
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: { fetch: fetchWithTimeout }, // hard per-request timeout (supabase-js has none)
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called during a Server Component render, where cookies are read-only.
          // Safe to ignore: src/proxy.ts refreshes the session on every request.
          // Server Actions and Route Handlers can set cookies, so this only triggers in renders.
        }
      },
    },
  });
}
