import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

/**
 * Data Access Layer for identity. The ONLY place that decides who the current teacher is.
 *
 * - Identity comes from verified JWT claims (`getClaims()` checks the signature against the
 *   project's JWKS and the expiry) or from the Auth server (`getUser()`), never from
 *   `getSession()`, cookies read by hand, or any client-provided user id.
 * - Results are memoised per request with React `cache()`, never across requests or users
 *   (no `use cache`, which would outlive a sign-out).
 * - These checks gate rendering and Server Actions; Row Level Security remains the final
 *   authorization boundary for every query.
 * - Call from inside a <Suspense> boundary: reading cookies is request data (Cache Components).
 */

export type CurrentUser = {
  id: string;
  email: string | null;
};

export type CurrentProfile = CurrentUser & {
  fullName: string | null;
};

const userId = z.uuid();

/** Signed-in teacher from verified claims, or null. Cheap: verifies the JWT locally. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient();
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data) return null;
    const { claims } = data;
    if (claims.role !== "authenticated" || claims.is_anonymous === true) return null;
    const id = userId.safeParse(claims.sub);
    if (!id.success) return null;
    return { id: id.data, email: typeof claims.email === "string" ? claims.email : null };
  } catch {
    // Fail closed (treated as signed out). Never log tokens or cookie values.
    return null;
  }
});

/** Like getCurrentUser, but redirects to the login page when nobody is signed in. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Strongest check, for destructive or sensitive operations (deleting data, issuing signed
 * storage URLs, calling `svc_*` functions): asks the Auth server, so a deleted, banned or
 * signed-out-everywhere user is rejected even while their access token has not expired yet.
 */
export const requireVerifiedUser = cache(async (): Promise<CurrentUser> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  const id = userId.safeParse(data.user?.id);
  if (error || !data.user || !id.success || data.user.is_anonymous) redirect("/login?notice=session_expired");
  return { id: id.data, email: data.user.email ?? null };
});

/** Signed-in teacher plus display name from public.profiles (read through RLS). */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile> => {
  const user = await requireUser();
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const fullName: unknown = data?.full_name;
  return { ...user, fullName: typeof fullName === "string" && fullName.length > 0 ? fullName : null };
});
