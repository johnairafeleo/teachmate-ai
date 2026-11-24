/**
 * Fixed copy for `?notice=` and `?error=` codes on the login page. Only known codes render, so a
 * crafted URL can never inject text into the page.
 */

const NOTICES = {
  signed_out: "You’ve been signed out. See you next lesson!",
  session_expired: "Your session has ended. Please sign in again to continue.",
} as const;

const ERRORS = {
  link_expired: "That confirmation link has expired. Sign in below to request a new one.",
  link_invalid: "That confirmation link isn’t valid or was already used. Try signing in, or request a new link.",
  confirm_sign_in:
    "We couldn’t finish signing you in from that link. If you’ve already confirmed your email, sign in below.",
} as const;

export type AuthNoticeCode = keyof typeof NOTICES;
export type AuthErrorCode = keyof typeof ERRORS;

function lookup<T extends Record<string, string>>(table: T, code: unknown): string | undefined {
  return typeof code === "string" && Object.hasOwn(table, code) ? table[code as keyof T] : undefined;
}

export const authNoticeMessage = (code: unknown) => lookup(NOTICES, code);
export const authErrorMessage = (code: unknown) => lookup(ERRORS, code);
