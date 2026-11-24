/**
 * A `fetch` for Supabase clients with a hard per-request timeout. supabase-js has none of its
 * own, and several calls (Auth getUser, Storage exists/remove) take no AbortSignal, so without
 * this a stalled connection could hold a request until the platform kills the function.
 * The timeout aborts the underlying request (and its body read); a caller's own signal still
 * applies, whichever fires first.
 */
export const SUPABASE_FETCH_TIMEOUT_MS = 10_000;

export const fetchWithTimeout: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};
