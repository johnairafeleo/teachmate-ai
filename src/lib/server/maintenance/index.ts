import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { verifyCronAuthorization } from "./cron-auth.ts";
import { runMaintenance, type MaintenanceSummary } from "./service.ts";

let warnedUnconfigured = false;

/** True only for `Authorization: Bearer <CRON_SECRET>` with a configured secret (≥ 32 chars). */
export function isAuthorizedCronRequest(authorizationHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret && !warnedUnconfigured) {
    warnedUnconfigured = true;
    console.error("[maintenance] CRON_SECRET is not configured; the maintenance endpoint rejects all requests.");
  }
  return verifyCronAuthorization(authorizationHeader, secret);
}

/** Runs one bounded maintenance pass with the service-role client (never exposed elsewhere). */
export async function runScheduledMaintenance(): Promise<MaintenanceSummary> {
  return runMaintenance({ admin: createAdminClient() });
}

export type { MaintenanceSummary } from "./service.ts";
