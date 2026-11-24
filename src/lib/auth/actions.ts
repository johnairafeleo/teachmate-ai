"use server";

import { redirect } from "next/navigation";

import {
  fieldErrorsFrom,
  formText,
  resendSchema,
  signInSchema,
  signUpSchema,
  type ResendState,
  type SignInField,
  type SignInState,
  type SignUpField,
  type SignUpState,
} from "@/lib/auth/schemas";
import { safeNextPath } from "@/lib/auth/redirect";
import { getPublicEnv } from "@/lib/env/public";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth Server Actions. They use the user-scoped Supabase client (publishable key), never the
 * admin client. Inputs are validated with Zod; provider errors are mapped to fixed copy and only
 * the error code is logged (never emails, passwords or tokens).
 * Next.js checks the Origin header of Server Action requests, which protects against CSRF.
 */

/** Confirmation links return here. Built from trusted config, never from request headers. */
function confirmUrl(): string {
  return new URL("/auth/confirm", getPublicEnv().NEXT_PUBLIC_SITE_URL).toString();
}

function logAuthError(action: string, error: { code?: string; status?: number }) {
  console.error(`[auth] ${action} failed: code=${error.code ?? "unknown"} status=${error.status ?? "?"}`);
}

const TRY_AGAIN = "Something went wrong on our side. Please try again in a moment.";
const RATE_LIMITED = "Too many attempts. Please wait a few minutes and try again.";
const EMAIL_LIMITED = "We’ve sent too many emails recently. Please wait a while before trying again.";

export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const values = { email: formText(formData, "email").trim().slice(0, 254) };
  const parsed = signInSchema.safeParse({ email: formText(formData, "email"), password: formText(formData, "password") });
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsFrom<SignInField>(parsed.error), values };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    switch (error.code) {
      case "invalid_credentials":
        return { status: "error", message: "That email and password don’t match. Check them and try again.", values };
      case "email_not_confirmed":
        return {
          status: "error",
          reason: "email_not_confirmed",
          message: "Please confirm your email address first. Open the link we sent to your inbox.",
          values,
        };
      case "over_request_rate_limit":
        return { status: "error", message: RATE_LIMITED, values };
      default:
        logAuthError("signIn", error);
        return { status: "error", message: TRY_AGAIN, values };
    }
  }

  redirect(safeNextPath(formData.get("next")));
}

export async function signUp(_previous: SignUpState, formData: FormData): Promise<SignUpState> {
  const values = {
    email: formText(formData, "email").trim().slice(0, 254),
    fullName: formText(formData, "fullName").slice(0, 120),
  };
  const parsed = signUpSchema.safeParse({
    fullName: formText(formData, "fullName"),
    email: formText(formData, "email"),
    password: formText(formData, "password"),
  });
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsFrom<SignUpField>(parsed.error), values };
  }

  const { email, password, fullName } = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // Only the name goes into user metadata; the auth.users trigger copies it into profiles.
    options: { emailRedirectTo: confirmUrl(), data: { full_name: fullName } },
  });

  if (error) {
    switch (error.code) {
      case "weak_password":
        return {
          status: "error",
          fieldErrors: { password: "Choose a stronger password: longer, and not one you use elsewhere." },
          values,
        };
      case "email_address_invalid":
        return { status: "error", fieldErrors: { email: "This email address can’t be used. Try another one." }, values };
      case "user_already_exists":
      case "email_exists":
        // Same answer as a new sign-up, so the form never reveals which emails have accounts.
        return { status: "success", values: { email } };
      case "over_email_send_rate_limit":
        return { status: "error", message: EMAIL_LIMITED, values };
      case "over_request_rate_limit":
        return { status: "error", message: RATE_LIMITED, values };
      case "signup_disabled":
        return { status: "error", message: "New sign-ups are closed right now. Please check back later.", values };
      default:
        // Includes email_address_not_authorized (Supabase's built-in mailer without custom SMTP).
        logAuthError("signUp", error);
        return { status: "error", message: "We couldn’t create your account right now. Please try again later.", values };
    }
  }

  // Only when email confirmation is turned off in Supabase: the teacher is signed in already.
  if (data.session) redirect("/dashboard");

  // For an existing address Supabase also returns success (without sending a new account email).
  return { status: "success", values: { email } };
}

export async function resendConfirmation(_previous: ResendState, formData: FormData): Promise<ResendState> {
  const parsed = resendSchema.safeParse({ email: formText(formData, "email") });
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsFrom<"email">(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: parsed.data.email,
    options: { emailRedirectTo: confirmUrl() },
  });

  if (error) {
    if (error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit") {
      return { status: "error", message: EMAIL_LIMITED };
    }
    logAuthError("resendConfirmation", error);
  }
  // Generic on purpose: never confirm whether an address has an account.
  return {
    status: "success",
    message: "If that address is waiting to be confirmed, a new link is on its way. Check your inbox and spam folder.",
  };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  // "local" ends this browser's session only; other devices stay signed in.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) logAuthError("signOut", error);
  redirect("/login?notice=signed_out");
}
