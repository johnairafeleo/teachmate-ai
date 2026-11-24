import { createBrowserClient } from "@supabase/ssr";

import { getPublicEnv } from "@/lib/env/public";

/**
 * Browser Supabase client (publishable key + the user's session cookies; RLS applies).
 *
 * Use sparingly: data reads belong in Server Components and writes in Server Actions.
 * Planned browser use is limited to uploading files with server-issued signed upload URLs.
 * `createBrowserClient` returns a singleton per browser tab.
 */
export function createClient() {
  const env = getPublicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
