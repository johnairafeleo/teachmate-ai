import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getPublicEnv } from "@/lib/env/public";
import { getServerEnv } from "@/lib/env/server";
import { fetchWithTimeout } from "@/lib/supabase/fetch-timeout";

/**
 * ADMIN Supabase client — uses the SECRET key and BYPASSES Row Level Security.
 *
 * Rules (see CLAUDE.md → "Admin client"):
 * 1. Import only from `src/lib/server/**` (enforced by ESLint `no-restricted-imports`).
 *    Those modules expose narrow, typed operations; never hand this client to other code.
 * 2. Use it only to call `svc_*` database functions and for server-side Storage operations.
 *    No direct table reads/writes.
 * 3. Every call is scoped by a user id taken from verified claims (`getClaims()`/`getUser()`),
 *    never from request input.
 * 4. Built with plain supabase-js (not @supabase/ssr) and no cookies, so a user's session can
 *    never replace the secret key's authorization, and nothing is persisted.
 * 5. Never log the key, tokens, or document contents.
 */
export function createAdminClient(): SupabaseClient {
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { SUPABASE_SECRET_KEY } = getServerEnv();

  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchWithTimeout },
  });
}
