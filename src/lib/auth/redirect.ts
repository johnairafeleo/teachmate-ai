/** Where teachers land after signing in or confirming their email. */
export const DEFAULT_AFTER_SIGN_IN = "/dashboard";

/** Routes that require a signed-in teacher. The proxy and the DAL both rely on this. */
export function isProtectedPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

/** Pages that a signed-in teacher should skip. */
export function isAuthPagePath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/signup";
}

/**
 * Sanitise a post-login redirect target (`?next=`) to prevent open redirects.
 * Only same-origin paths inside the protected app area are allowed; anything else falls back to
 * the dashboard. The value is normalised first, so `/dashboard/../x`, `//evil.example`,
 * `/\evil.example` and absolute URLs are all rejected.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return DEFAULT_AFTER_SIGN_IN;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001F\u007F]/.test(value)) {
    return DEFAULT_AFTER_SIGN_IN;
  }
  try {
    const base = "http://teachmate.invalid";
    const url = new URL(value, base);
    if (url.origin !== base || !isProtectedPath(url.pathname)) return DEFAULT_AFTER_SIGN_IN;
    return `${url.pathname}${url.search}`;
  } catch {
    return DEFAULT_AFTER_SIGN_IN;
  }
}
