// Server-only: uses the service-role client. Node tests resolve the `react-server` condition.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { classifyStorageError } from "../documents/storage-errors.ts";

/**
 * Scheduled maintenance (Vercel Cron → GET /api/internal/maintenance).
 *
 * Candidates come from the database (svc_maintenance_candidates / svc_find_orphan_objects), never
 * from a request. Every candidate is RE-READ (scoped to the owner id the database reported) and
 * re-checked for status and age right before acting; anything that no longer qualifies is
 * skipped. Every step is idempotent, so a run that stops halfway is simply continued by the next.
 *
 *  - pending_upload > 24 h       → begin deletion → remove object (if any) → finish deletion
 *  - processing > 15 min         → svc_fail_document(INTERNAL_ERROR); object removed only once a
 *                                  fresh read shows `failed` (same rule as the document service)
 *  - uploaded > 15 min           → left alone: a verified upload the teacher can still process
 *  - deleting document > 15 min  → resume: remove object → finish deletion (row goes only when
 *                                  the object is gone — enforced in SQL)
 *  - failed > 7 days             → same deletion path
 *  - presentation deleting       → remove every object under user/presentation/ → finish (SQL
 *                                  refuses while any object remains; rows cascade)
 *  - generating > 15 min         → svc_fail_generation
 *  - exports superseded          → deferred until PPTX export exists (counted, not touched)
 *  - orphan objects (> 1 h)      → confirmed per object (expected path shape, and a successful
 *                                  database lookup that finds no row) before deletion; a failed
 *                                  lookup never leads to deletion
 *  - quota ledger                → svc_prune_upload_quota_usage(7)
 *
 * Logs carry counts and fixed codes only: no document text, ids, storage paths or secrets.
 */

const BUCKETS = { source: "source-materials", exports: "presentation-exports" } as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OBJECT_PATH = {
  [BUCKETS.source]: new RegExp(`^${UUID}/${UUID}/${UUID}\\.(pdf|docx)$`),
  [BUCKETS.exports]: new RegExp(`^${UUID}/${UUID}/${UUID}\\.pptx$`),
} as const;

export type MaintenanceOptions = {
  /** Rows per candidate kind from svc_maintenance_candidates (default 50). */
  candidateLimit?: number;
  /** Orphan objects examined per run (default 100). */
  orphanLimit?: number;
  /** Stop starting new work after this many ms (default 45 s; route maxDuration is 60 s). */
  timeBudgetMs?: number;
  /** Re-check thresholds; defaults match the SQL candidate rules. Tests may lower them. */
  pendingUploadMaxAgeMs?: number;
  stuckProcessingMs?: number;
  deletingResumeMs?: number;
  failedRetentionMs?: number;
  stuckGenerationMs?: number;
  orphanMinAge?: string; // Postgres interval for svc_find_orphan_objects
  quotaKeepDays?: number;
};

export type MaintenanceContext = {
  admin: SupabaseClient;
  log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  options?: MaintenanceOptions;
};

export type MaintenanceSummary = {
  pendingUploadsRemoved: number;
  stuckProcessingRecovered: number;
  uploadedAwaitingTeacher: number;
  documentDeletionsCompleted: number;
  failedDocumentsRemoved: number;
  presentationDeletionsCompleted: number;
  stuckGenerationsFailed: number;
  exportsDeferred: number;
  orphansRemoved: number;
  orphansSkipped: number;
  quotaRowsPruned: number;
  skipped: number;
  errors: number;
  timedOut: boolean;
};

export const emptySummary = (): MaintenanceSummary => ({
  pendingUploadsRemoved: 0,
  stuckProcessingRecovered: 0,
  uploadedAwaitingTeacher: 0,
  documentDeletionsCompleted: 0,
  failedDocumentsRemoved: 0,
  presentationDeletionsCompleted: 0,
  stuckGenerationsFailed: 0,
  exportsDeferred: 0,
  orphansRemoved: 0,
  orphansSkipped: 0,
  quotaRowsPruned: 0,
  skipped: 0,
  errors: 0,
  timedOut: false,
});

type Outcome = "done" | "skipped" | "error";

const opt = <K extends keyof MaintenanceOptions>(ctx: MaintenanceContext, key: K, fallback: NonNullable<MaintenanceOptions[K]>) =>
  (ctx.options?.[key] ?? fallback) as NonNullable<MaintenanceOptions[K]>;

function log(ctx: MaintenanceContext, event: string, fields: Record<string, string | number | boolean> = {}) {
  if (ctx.log) ctx.log(event, fields);
  else console.error(`[maintenance] ${event} ${JSON.stringify(fields)}`);
}

const olderThan = (timestamp: string, ms: number) => {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) && Date.now() - t >= ms;
};

// ------------------------------------------------------------------ documents

type DocumentRow = { id: string; user_id: string; storage_path: string; processing_status: string; created_at: string; updated_at: string };

async function readDocument(ctx: MaintenanceContext, ownerId: string, documentId: string): Promise<{ row: DocumentRow } | { missing: true } | { error: string }> {
  const { data, error } = await ctx.admin
    .from("source_documents")
    .select("id, user_id, storage_path, processing_status, created_at, updated_at")
    .eq("id", documentId)
    .eq("user_id", ownerId) // the owner the database reported; a mismatch reads as missing
    .maybeSingle();
  if (error) return { error: error.code || "db_error" };
  return data ? { row: data as DocumentRow } : { missing: true };
}

/** Storage remove; never throws. Removing an absent object is a no-op success. */
async function removeObjects(ctx: MaintenanceContext, bucket: string, paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await ctx.admin.storage.from(bucket).remove(paths);
    if (error) {
      log(ctx, "storage.remove_failed", { bucket, count: paths.length, code: classifyStorageError(error) });
      return false;
    }
    return true;
  } catch {
    log(ctx, "storage.remove_threw", { bucket, count: paths.length });
    return false;
  }
}

/** begin (→ deleting) → remove object → finish (row deleted only if the object is gone). */
async function deleteDocument(ctx: MaintenanceContext, ownerId: string, documentId: string): Promise<Outcome> {
  const begin = await ctx.admin.rpc("svc_begin_document_deletion", { p_user_id: ownerId, p_document_id: documentId });
  if (begin.error) {
    if (begin.error.code === "P0002") return "skipped"; // already gone
    log(ctx, "document.begin_deletion_failed", { sqlstate: begin.error.code || "network" });
    return "error";
  }
  const path = typeof begin.data === "string" ? begin.data : "";
  if (!path || !(await removeObjects(ctx, BUCKETS.source, [path]))) return "error"; // stays `deleting`; next run resumes
  const finish = await ctx.admin.rpc("svc_finish_document_deletion", { p_user_id: ownerId, p_document_id: documentId });
  if (finish.error) {
    log(ctx, "document.finish_deletion_failed", { sqlstate: finish.error.code || "network" });
    return "error";
  }
  if (finish.data !== true) {
    log(ctx, "document.object_remains");
    return "error";
  }
  return "done";
}

/** document_cleanup candidates: pending > 24 h, deleting > 15 min, failed > 7 days. */
export async function cleanupDocument(ctx: MaintenanceContext, ownerId: string, documentId: string): Promise<{ outcome: Outcome; kind?: "pending" | "deleting" | "failed" }> {
  const fresh = await readDocument(ctx, ownerId, documentId);
  if ("error" in fresh) {
    log(ctx, "document.read_failed", { sqlstate: fresh.error });
    return { outcome: "error" };
  }
  if ("missing" in fresh) return { outcome: "skipped" };
  const { row } = fresh;
  if (row.processing_status === "pending_upload" && olderThan(row.created_at, opt(ctx, "pendingUploadMaxAgeMs", DAY))) {
    return { outcome: await deleteDocument(ctx, ownerId, documentId), kind: "pending" };
  }
  if (row.processing_status === "deleting" && olderThan(row.updated_at, opt(ctx, "deletingResumeMs", 15 * MINUTE))) {
    return { outcome: await deleteDocument(ctx, ownerId, documentId), kind: "deleting" };
  }
  if (row.processing_status === "failed" && olderThan(row.updated_at, opt(ctx, "failedRetentionMs", 7 * DAY))) {
    return { outcome: await deleteDocument(ctx, ownerId, documentId), kind: "failed" };
  }
  return { outcome: "skipped" }; // ready / uploaded / processing, or no longer old enough
}

/** document_stuck candidates: processing > 15 min is recovered; uploaded is left for the teacher. */
export async function recoverStuckDocument(ctx: MaintenanceContext, ownerId: string, documentId: string): Promise<{ outcome: Outcome; awaitingTeacher?: boolean }> {
  const fresh = await readDocument(ctx, ownerId, documentId);
  if ("error" in fresh) {
    log(ctx, "document.read_failed", { sqlstate: fresh.error });
    return { outcome: "error" };
  }
  if ("missing" in fresh) return { outcome: "skipped" };
  if (fresh.row.processing_status === "uploaded") return { outcome: "skipped", awaitingTeacher: true };
  if (fresh.row.processing_status !== "processing" || !olderThan(fresh.row.updated_at, opt(ctx, "stuckProcessingMs", 15 * MINUTE))) {
    return { outcome: "skipped" };
  }
  // svc_fail_document only changes pending_upload/uploaded/processing rows: a row that became
  // ready or failed meanwhile is never overwritten. Since migration 0800 it also refuses a token
  // attempt that changed less than 2 minutes ago (database clock), so a live worker is never
  // failed here; the re-read below then reports "skipped".
  const failed = await ctx.admin.rpc("svc_fail_document", { p_user_id: ownerId, p_document_id: documentId, p_error: "INTERNAL_ERROR" });
  if (failed.error) {
    log(ctx, "document.fail_rpc_failed", { sqlstate: failed.error.code || "network" });
    return { outcome: "error" };
  }
  const after = await readDocument(ctx, ownerId, documentId);
  if ("error" in after) return { outcome: "error" };
  if ("missing" in after || after.row.processing_status !== "failed") return { outcome: "skipped" };
  // Same rule as the document service: a failed document's object is deleted.
  return { outcome: (await removeObjects(ctx, BUCKETS.source, [after.row.storage_path])) ? "done" : "error" };
}

// ------------------------------------------------------------------ presentations

export async function resumePresentationDeletion(ctx: MaintenanceContext, ownerId: string, presentationId: string): Promise<Outcome> {
  const { data: presentation, error } = await ctx.admin
    .from("presentations")
    .select("id, deleting_at")
    .eq("id", presentationId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) {
    log(ctx, "presentation.read_failed", { sqlstate: error.code || "network" });
    return "error";
  }
  if (!presentation) return "skipped";
  // Only presentations someone already asked to delete; active presentations are never touched.
  if (!presentation.deleting_at || !olderThan(presentation.deleting_at as string, opt(ctx, "deletingResumeMs", 15 * MINUTE))) return "skipped";

  const begin = await ctx.admin.rpc("svc_begin_presentation_deletion", { p_user_id: ownerId, p_presentation_id: presentationId });
  if (begin.error) {
    if (begin.error.code === "P0002") return "skipped";
    log(ctx, "presentation.begin_deletion_failed", { sqlstate: begin.error.code || "network" });
    return "error";
  }
  const listed = (begin.data ?? []) as { out_bucket: string; out_path: string }[];
  for (const bucket of [BUCKETS.source, BUCKETS.exports]) {
    const paths = listed.filter((entry) => entry.out_bucket === bucket).map((entry) => entry.out_path);
    for (let i = 0; i < paths.length; i += 100) {
      if (!(await removeObjects(ctx, bucket, paths.slice(i, i + 100)))) return "error";
    }
  }

  let finish = await ctx.admin.rpc("svc_finish_presentation_deletion", { p_user_id: ownerId, p_presentation_id: presentationId });
  if (finish.error?.code === "55000") {
    // Objects without rows under this presentation's prefix (e.g. an upload whose row was already
    // removed). Everything under user/presentation/ belongs to the presentation being deleted.
    for (const bucket of [BUCKETS.source, BUCKETS.exports]) {
      const prefix = `${ownerId}/${presentationId}`;
      const { data: objects, error: listError } = await ctx.admin.storage.from(bucket).list(prefix, { limit: 100 });
      if (listError) return "error";
      const paths = (objects ?? []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
      if (!(await removeObjects(ctx, bucket, paths))) return "error";
    }
    finish = await ctx.admin.rpc("svc_finish_presentation_deletion", { p_user_id: ownerId, p_presentation_id: presentationId });
  }
  if (finish.error) {
    log(ctx, "presentation.finish_deletion_failed", { sqlstate: finish.error.code || "network" });
    return "error";
  }
  return finish.data === true ? "done" : "skipped";
}

export async function failStuckGeneration(ctx: MaintenanceContext, ownerId: string, presentationId: string): Promise<Outcome> {
  const { data, error } = await ctx.admin
    .from("presentations")
    .select("status, updated_at, deleting_at")
    .eq("id", presentationId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) return "error";
  if (!data || data.status !== "generating" || data.deleting_at || !olderThan(data.updated_at as string, opt(ctx, "stuckGenerationMs", 15 * MINUTE))) {
    return "skipped";
  }
  const failed = await ctx.admin.rpc("svc_fail_generation", { p_user_id: ownerId, p_presentation_id: presentationId, p_message: "INTERNAL_ERROR" });
  if (failed.error) {
    log(ctx, "generation.fail_rpc_failed", { sqlstate: failed.error.code || "network" });
    return "error";
  }
  return "done";
}

// ------------------------------------------------------------------ orphans and ledger

/** Orphans from svc_find_orphan_objects, each confirmed before deletion. */
export async function cleanupOrphans(ctx: MaintenanceContext): Promise<{ removed: number; skipped: number; errors: number }> {
  const result = { removed: 0, skipped: 0, errors: 0 };
  const { data, error } = await ctx.admin.rpc("svc_find_orphan_objects", {
    p_older_than: opt(ctx, "orphanMinAge", "1 hour"),
    p_limit: opt(ctx, "orphanLimit", 100),
  });
  if (error) {
    log(ctx, "orphans.query_failed", { sqlstate: error.code || "network" });
    result.errors += 1;
    return result;
  }
  const confirmed: Record<string, string[]> = { [BUCKETS.source]: [], [BUCKETS.exports]: [] };
  for (const { out_bucket: bucket, out_path: path } of (data ?? []) as { out_bucket: string; out_path: string }[]) {
    const pattern = OBJECT_PATH[bucket as keyof typeof OBJECT_PATH];
    if (!pattern || !pattern.test(path)) {
      result.skipped += 1; // not an object this app created: never delete it
      continue;
    }
    const table = bucket === BUCKETS.source ? "source_documents" : "presentation_exports";
    const { count, error: lookupError } = await ctx.admin.from(table).select("id", { count: "exact", head: true }).eq("storage_path", path);
    if (lookupError || count === null) {
      result.errors += 1; // a failed lookup is not proof of an orphan
      continue;
    }
    if (count > 0) {
      result.skipped += 1; // a row exists (again): not an orphan
      continue;
    }
    confirmed[bucket].push(path);
  }
  for (const [bucket, paths] of Object.entries(confirmed)) {
    if (paths.length === 0) continue;
    if (await removeObjects(ctx, bucket, paths)) result.removed += paths.length;
    else result.errors += 1;
  }
  return result;
}

export async function pruneQuotaLedger(ctx: MaintenanceContext): Promise<{ pruned: number; error: boolean }> {
  const { data, error } = await ctx.admin.rpc("svc_prune_upload_quota_usage", { p_keep_days: opt(ctx, "quotaKeepDays", 7) });
  if (error) {
    log(ctx, "quota.prune_failed", { sqlstate: error.code || "network" });
    return { pruned: 0, error: true };
  }
  return { pruned: Number(data ?? 0), error: false };
}

// ------------------------------------------------------------------ orchestration

export async function runMaintenance(ctx: MaintenanceContext): Promise<MaintenanceSummary> {
  const summary = emptySummary();
  const deadline = Date.now() + opt(ctx, "timeBudgetMs", 45_000);
  const outOfTime = () => {
    if (Date.now() < deadline) return false;
    summary.timedOut = true;
    return true;
  };
  const count = (outcome: Outcome, onDone: () => void) => {
    if (outcome === "done") onDone();
    else if (outcome === "skipped") summary.skipped += 1;
    else summary.errors += 1;
  };

  const { data, error } = await ctx.admin.rpc("svc_maintenance_candidates", { p_limit: opt(ctx, "candidateLimit", 50) });
  if (error) {
    log(ctx, "candidates.query_failed", { sqlstate: error.code || "network" });
    summary.errors += 1;
  }
  for (const candidate of (data ?? []) as { kind: string; owner_id: string; target_id: string }[]) {
    if (outOfTime()) break;
    switch (candidate.kind) {
      case "document_cleanup": {
        const { outcome, kind } = await cleanupDocument(ctx, candidate.owner_id, candidate.target_id);
        count(outcome, () => {
          if (kind === "pending") summary.pendingUploadsRemoved += 1;
          else if (kind === "failed") summary.failedDocumentsRemoved += 1;
          else summary.documentDeletionsCompleted += 1;
        });
        break;
      }
      case "document_stuck": {
        const { outcome, awaitingTeacher } = await recoverStuckDocument(ctx, candidate.owner_id, candidate.target_id);
        if (awaitingTeacher) summary.uploadedAwaitingTeacher += 1;
        else count(outcome, () => (summary.stuckProcessingRecovered += 1));
        break;
      }
      case "presentation_deleting":
        count(await resumePresentationDeletion(ctx, candidate.owner_id, candidate.target_id), () => (summary.presentationDeletionsCompleted += 1));
        break;
      case "generation_stuck":
        count(await failStuckGeneration(ctx, candidate.owner_id, candidate.target_id), () => (summary.stuckGenerationsFailed += 1));
        break;
      case "export_superseded":
        summary.exportsDeferred += 1; // PPTX export is not implemented yet
        break;
      default:
        summary.skipped += 1;
    }
  }

  if (!outOfTime()) {
    const orphans = await cleanupOrphans(ctx);
    summary.orphansRemoved += orphans.removed;
    summary.orphansSkipped += orphans.skipped;
    summary.errors += orphans.errors;
  }
  if (!outOfTime()) {
    const ledger = await pruneQuotaLedger(ctx);
    summary.quotaRowsPruned += ledger.pruned;
    if (ledger.error) summary.errors += 1;
  }

  log(ctx, "run.completed", { ...summary });
  return summary;
}
