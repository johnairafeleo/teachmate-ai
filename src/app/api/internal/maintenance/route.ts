import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCronRequest, runScheduledMaintenance } from "@/lib/server/maintenance";

/**
 * Scheduled maintenance, called once a day by Vercel Cron (see vercel.json).
 * Authorization: `Authorization: Bearer <CRON_SECRET>` only (constant-time check). Anything else
 * gets a bare 401. The response is a small count summary — no ids, paths or error details.
 */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { ...NO_STORE, "WWW-Authenticate": "Bearer" } });
  }
  try {
    const summary = await runScheduledMaintenance();
    return NextResponse.json({ ok: summary.errors === 0, summary }, { headers: NO_STORE });
  } catch (error) {
    console.error(`[maintenance] run threw ${error instanceof Error ? error.name : "unknown"}`);
    return NextResponse.json({ ok: false }, { status: 500, headers: NO_STORE });
  }
}
