import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import type { AuthErrorCode } from "@/lib/auth/messages";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

/**
 * Email confirmation callback (`/auth/confirm`). Supports both link styles:
 *
 * 1. `?token_hash=…&type=email` — recommended. Needs the Supabase "Confirm signup" email template
 *    to link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`.
 *    Works on any device or browser.
 * 2. `?code=…` — Supabase's default template (PKCE). Supabase has already confirmed the address
 *    before redirecting here; exchanging the code needs the verifier cookie from the browser
 *    that signed up, so a link opened elsewhere falls back to "please sign in".
 *
 * Supabase reports failures as `?error=…&error_code=…`. Provider text is never echoed back.
 * Only sign-up/email links are accepted; recovery, invite and email-change flows don't exist yet.
 */

const ACCEPTED_TYPES = new Set<EmailOtpType>(["email", "signup"]);
const MAX_PARAM_LENGTH = 1024;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeNextPath(params.get("next"));

  if (params.has("error") || params.has("error_code")) {
    return failure(request, params.get("error_code") === "otp_expired" ? "link_expired" : "link_invalid");
  }

  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const code = params.get("code");

  if (tokenHash && type) {
    if (!ACCEPTED_TYPES.has(type) || tokenHash.length > MAX_PARAM_LENGTH) return failure(request, "link_invalid");
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
    if (error) {
      logFailure("verifyOtp", error);
      return failure(request, error.code === "otp_expired" ? "link_expired" : "link_invalid");
    }
    return redirectTo(request, next);
  }

  if (code) {
    if (code.length > MAX_PARAM_LENGTH) return failure(request, "link_invalid");
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      logFailure("exchangeCodeForSession", error);
      return failure(request, error.code === "flow_state_expired" ? "link_expired" : "confirm_sign_in");
    }
    return redirectTo(request, next);
  }

  return failure(request, "link_invalid");
}

function failure(request: NextRequest, code: AuthErrorCode) {
  return redirectTo(request, `/login?error=${code}`);
}

/**
 * Same-origin redirect (the session cookie was just set for this host). 303 so the browser
 * follows with GET, and no-store so neither the token URL nor the cookie-setting response is cached.
 * Cookies set through `cookies()` by the Supabase client are attached to this response by Next.js.
 */
function redirectTo(request: NextRequest, path: string) {
  const response = NextResponse.redirect(new URL(path, request.nextUrl.origin), 303);
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function logFailure(step: string, error: { code?: string; status?: number }) {
  console.error(`[auth] confirm ${step} failed: code=${error.code ?? "unknown"} status=${error.status ?? "?"}`);
}
