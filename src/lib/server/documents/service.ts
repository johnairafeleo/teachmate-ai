// Server-only: importing this from a Client Component is a build error. Node tests resolve the
// `react-server` export condition (npm run test:integration), which maps it to an empty module.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ExtractionError } from "../../documents/errors.ts";
import { acquireExtractionSlot, extractDocumentIsolated, hasMemoryForExtraction, MemoryPressureError, WORKER_LIMITS, type MemoryLimits } from "../../documents/isolated-extract.ts";
import { EXTRACTION_LIMITS, SUPPORTED_MIME_TYPES } from "../../documents/limits.ts";
import { mapDatabaseError, safeError, storedErrorToSafe, type DocumentErrorCode, type SafeError } from "./errors.ts";
import { createDraftInputSchema, documentIdSchema, issueFields, presentationIdSchema } from "./schemas.ts";
import { classifyStorageError, storageErrorTag } from "./storage-errors.ts";

/**
 * Document service core: draft creation, upload verification + extraction, status reads.
 *
 * Callers pass an explicit context; the server-only wrapper (./index.ts) builds it from the
 * request's verified identity. Nothing here reads identity from input.
 *
 *  - `userId` comes from requireVerifiedUser() (Auth server round trip), never from the client.
 *  - `db` is the request's user-scoped client (publishable key + session; RLS applies). All owner
 *    reads and Storage downloads go through it, so a document the user doesn't own is invisible.
 *  - `admin` (secret key) is used only for svc_* RPCs and Storage deletion, always scoped to
 *    `userId` and only after `db` has proven ownership of the row.
 *
 * Status flow (DB-enforced): pending_upload → uploaded → processing → ready | failed, plus
 * processing → uploaded after SHARED memory pressure (svc_release_document_processing, at most
 * twice per document; the third time → failed SERVER_CAPACITY).
 *
 * Attempt tokens (migration 0800): every claim returns a fresh processing_attempt token; after the
 * claim, save, fail and release are token-scoped, so a stale request can never change a newer
 * attempt. The unscoped svc_fail_document is used only BEFORE a claim and for abandoned rows
 * (the database refuses it for a token attempt younger than 2 minutes).
 * The download happens while the row is still `uploaded`, BEFORE the atomic
 * `uploaded → processing` claim: a transient Storage failure leaves the row retryable instead of
 * stranding it in `processing` (there is no SQL path back). The claim still guarantees that only
 * one caller extracts and saves.
 *
 * Extraction runs in an isolated worker thread (../../documents/isolated-extract.ts): hard
 * deadline, heap limits, a process RSS watchdog, one worker per process.
 *
 * Time budget (PROCESSING_BUDGET): one processDocument call, auth included, ends well inside the
 * route's maxDuration (60 s); see the constant for the arithmetic.
 */

export const SOURCE_BUCKET = "source-materials";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export type ReadContext = {
  userId: string;
  db: SupabaseClient;
  log?: (event: string, fields: LogFields) => void;
};

export type ServiceContext = ReadContext & {
  admin: SupabaseClient;
  /**
   * Absolute time (ms since epoch) by which processDocument must have finished its work. Set at
   * the start of the request (before the auth round trip) by ./index.ts; otherwise
   * PROCESSING_BUDGET.totalMs from the call.
   */
  deadlineAt?: number;
  /** Test hooks; production uses the defaults. */
  options?: {
    downloadAttempts?: number;
    retryDelayMs?: number;
    extractionDeadlineMs?: number;
    /** How long to wait for a free extraction worker before answering SERVER_BUSY (default 10 s). */
    slotWaitMs?: number;
    /** Tests only: a fault-injection worker. */
    workerUrl?: URL;
    /** Attempts to record a failure with svc_fail_document before giving up (default 3). */
    failRecordAttempts?: number;
    /** A row left in `processing` longer than this is treated as abandoned (default 120 s). */
    staleProcessingMs?: number;
    /** Total budget when ctx.deadlineAt is not given (default PROCESSING_BUDGET.totalMs). */
    processingBudgetMs?: number;
    /** Tests only: other memory ceilings or a fake RSS reader. */
    memory?: MemoryLimits;
  };
};

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: SafeError };

export type DocumentStatus = "pending_upload" | "uploaded" | "processing" | "ready" | "failed" | "deleting";

export type UploadTarget = {
  documentId: string;
  fileName: string;
  fileType: "pdf" | "docx";
  /** Upload with `file.slice(0, file.size, contentType)`; storage-js ignores the contentType option for Blobs. */
  contentType: string;
  storagePath: string;
  declaredSize: number;
  maxBytes: number;
};

export type DraftResult = { presentationId: string; bucket: typeof SOURCE_BUCKET; uploads: UploadTarget[] };

export type ExtractSummary = { charCount: number; pageCount: number | null; isTruncated: boolean };

export type ProcessResult = {
  documentId: string;
  status: DocumentStatus;
  /** Present when the document failed, or when the caller should try again later. */
  error?: SafeError;
  extract?: ExtractSummary;
  /** True when a failed document's object could not be deleted yet (retried on the next call). */
  cleanupPending?: boolean;
};

const ok = <T>(data: T): ServiceResult<T> => ({ ok: true, data });
const fail = <T>(code: DocumentErrorCode, fields?: string[]): ServiceResult<T> => ({ ok: false, error: safeError(code, fields) });

function log(ctx: ReadContext, event: string, fields: LogFields) {
  if (ctx.log) ctx.log(event, fields);
  else console.error(`[documents] ${event} ${JSON.stringify(fields)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Time budget for one processDocument request. The routes that call it set maxDuration = 60.
 *
 *  - Everything before the end of extraction must finish by deadline - finalizeReserveMs, so
 *    saving the result (or recording a failure) always has time left. Extraction gets
 *    min(20 s, time left - hardTimeoutGraceMs), and is not STARTED (nothing claimed, retryable
 *    SERVER_BUSY) when less than minExtractionMs would be left.
 *  - Every Supabase request that accepts an AbortSignal (PostgREST/RPC, Storage download) gets
 *    one that fires at min(requestTimeoutMs, time left) and aborts the real fetch (no
 *    Promise.race). Storage exists()/remove() take no signal: they are skipped when no time is
 *    left, and bounded by the clients' own fetch timeout (../../supabase/fetch-timeout.ts).
 *  - Worst case: totalMs (45 s) + one request without a signal (10 s) = 55 s < 60 s.
 *  - A request killed anyway leaves the row `processing`; DEFAULT_STALE_PROCESSING_MS (120 s,
 *    longer than maxDuration) lets the next call or the maintenance job record it as failed.
 */
export const PROCESSING_BUDGET = {
  totalMs: 45_000,
  finalizeReserveMs: 10_000,
  minExtractionMs: 3_000,
  requestTimeoutMs: 10_000,
} as const;

type Budget = { deadlineAt: number };

const timeLeft = (budget: Budget, reserveMs = 0) => budget.deadlineAt - reserveMs - Date.now();

/** An AbortSignal for one Supabase request: fires at min(requestTimeoutMs, time left). */
function requestSignal(budget: Budget, reserveMs = 0): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.min(PROCESSING_BUDGET.requestTimeoutMs, timeLeft(budget, reserveMs))));
}

// ------------------------------------------------------------------ draft creation

const draftRowSchema = z.object({
  out_document_id: z.uuid(),
  out_storage_path: z.string().min(1).max(300),
  out_original_filename: z.string(),
  out_file_type: z.enum(["pdf", "docx"]),
  out_file_size: z.coerce.number().int().positive(),
});

export async function createMaterialsDraft(ctx: ServiceContext, rawInput: unknown): Promise<ServiceResult<DraftResult>> {
  const parsed = createDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID_INPUT", issueFields(parsed.error));
  const input = parsed.data;

  const { data, error } = await ctx.db.rpc("create_materials_draft", {
    p_title: input.title,
    p_grade_level: input.grade,
    p_subject: input.subject,
    p_language: input.language,
    p_theme: input.theme,
    p_slide_count: input.slideCount,
    p_files: input.files.map((file) => ({ name: file.name, type: file.kind, size: file.size })),
  });
  if (error) {
    const code = mapDatabaseError(error);
    if (code === "INTERNAL_ERROR") log(ctx, "draft.rpc_failed", { sqlstate: error.code ?? null });
    return fail(code);
  }

  const rows = z.array(draftRowSchema).safeParse(data);
  if (!rows.success || rows.data.length !== input.files.length) {
    log(ctx, "draft.unexpected_rows", { count: Array.isArray(data) ? data.length : null });
    return fail("INTERNAL_ERROR");
  }

  // create_materials_draft returns document rows only; read the presentation id back through RLS.
  const first = rows.data[0];
  const { data: link, error: linkError } = await ctx.db
    .from("source_documents")
    .select("presentation_id")
    .eq("id", first.out_document_id)
    .maybeSingle();
  const presentationId = presentationIdSchema.safeParse(link?.presentation_id);
  if (linkError || !presentationId.success) {
    log(ctx, "draft.presentation_lookup_failed", { sqlstate: linkError?.code ?? null });
    return fail("INTERNAL_ERROR");
  }

  const prefix = `${ctx.userId}/${presentationId.data}/`;
  if (!rows.data.every((row) => row.out_storage_path === `${prefix}${row.out_document_id}.${row.out_file_type}`)) {
    // The session's user and the verified user disagree, or the path format changed: refuse.
    log(ctx, "draft.path_mismatch", { presentationId: presentationId.data });
    return fail("INTERNAL_ERROR");
  }

  return ok({
    presentationId: presentationId.data,
    bucket: SOURCE_BUCKET,
    uploads: rows.data.map((row, index) => ({
      documentId: row.out_document_id,
      fileName: row.out_original_filename,
      fileType: row.out_file_type,
      contentType: input.files[index].contentType,
      storagePath: row.out_storage_path,
      declaredSize: row.out_file_size,
      maxBytes: EXTRACTION_LIMITS.maxInputBytes,
    })),
  });
}

// ------------------------------------------------------------------ processing

const documentRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  presentation_id: z.uuid(),
  file_type: z.enum(["pdf", "docx"]),
  file_size: z.coerce.number().int().nonnegative(),
  storage_path: z.string().min(1),
  processing_status: z.enum(["pending_upload", "uploaded", "processing", "ready", "failed", "deleting"]),
  processing_error: z.string().nullable(),
  processing_attempt: z.uuid().nullable(),
  memory_release_count: z.coerce.number().int().min(0).max(2),
  updated_at: z.string(),
});
type DocumentRow = z.infer<typeof documentRowSchema>;
const attemptSchema = z.uuid();

/**
 * Extraction is bounded by a 20 s deadline (plus PDF.js overrun of a few seconds). A row still in
 * `processing` far beyond that was abandoned (crashed or killed request, or a failure that could
 * not be recorded), so the next call may record it as failed. A genuinely slow worker that
 * finishes afterwards cannot overwrite that: its token-scoped save requires its own attempt to
 * still be `processing`. The database additionally refuses to fail a token attempt that changed
 * less than 2 minutes ago (its own clock), so clock skew here can never fail a live worker.
 */
const DEFAULT_STALE_PROCESSING_MS = 120_000;

type ReadOutcome = { row: DocumentRow } | { failure: "NOT_FOUND" | "UNAUTHENTICATED" | "INTERNAL_ERROR" };

async function readDocument(ctx: ReadContext, documentId: string, budget: Budget): Promise<ReadOutcome> {
  const { data, error } = await ctx.db
    .from("source_documents")
    .select("id, user_id, presentation_id, file_type, file_size, storage_path, processing_status, processing_error, processing_attempt, memory_release_count, updated_at")
    .eq("id", documentId)
    .abortSignal(requestSignal(budget))
    .maybeSingle();
  if (error) {
    if (error.code === "42501") return { failure: "UNAUTHENTICATED" }; // no session (anon has no grant)
    log(ctx, "document.read_failed", { documentId, sqlstate: error.code ?? null });
    return { failure: "INTERNAL_ERROR" };
  }
  if (!data) return { failure: "NOT_FOUND" };
  const row = documentRowSchema.safeParse(data);
  if (!row.success) {
    log(ctx, "document.unexpected_row", { documentId });
    return { failure: "INTERNAL_ERROR" };
  }
  // Defence in depth: RLS already hides other users' rows.
  return row.data.user_id === ctx.userId ? { row: row.data } : { failure: "NOT_FOUND" };
}

async function readExtractSummary(ctx: ReadContext, documentId: string, budget: Budget): Promise<ExtractSummary | undefined> {
  const { data } = await ctx.db
    .from("document_extracts")
    .select("char_count, page_count, is_truncated")
    .eq("source_document_id", documentId)
    .abortSignal(requestSignal(budget))
    .maybeSingle();
  if (!data) return undefined;
  return { charCount: Number(data.char_count), pageCount: data.page_count ?? null, isTruncated: Boolean(data.is_truncated) };
}

/** Delete a failed document's object. Only ever called for rows confirmed `failed`. Idempotent. */
async function removeFailedObject(ctx: ServiceContext, row: DocumentRow, budget: Budget): Promise<boolean> {
  if (row.processing_status !== "failed") return false;
  // remove() takes no AbortSignal: don't start it without time left. The object then stays for
  // the next call or the maintenance job (cleanupPending).
  if (timeLeft(budget) <= 0) return false;
  const { error } = await ctx.admin.storage.from(SOURCE_BUCKET).remove([row.storage_path]);
  if (error) {
    log(ctx, "cleanup.remove_failed", { documentId: row.id, status: (error as { statusCode?: string }).statusCode ?? null });
    return false;
  }
  return true;
}

/**
 * Record a failure, then clean up — but only after a FRESH owner-scoped read confirms the row
 * really is `failed`.
 *
 * - With `attempt` (after a claim): svc_fail_document_attempt, which only fails that attempt.
 *   Without (before a claim, or an abandoned row): svc_fail_document.
 * - The RPC is retried a few times (it reports nothing, and may have committed even when the
 *   response was lost; the fresh read tells us).
 * - If the failure is not recorded, nothing is deleted and the request fails with a retryable
 *   INTERNAL_ERROR. No ordinary status is returned, so a client cannot mistake it for progress.
 *   A later call re-runs the same checks (before the claim) or, after the claim, recovers the row
 *   once it is stale (see DEFAULT_STALE_PROCESSING_MS).
 */
async function failDocument(ctx: ServiceContext, row: DocumentRow, code: DocumentErrorCode, budget: Budget, processingAttempt?: string): Promise<ServiceResult<ProcessResult>> {
  const attempts = ctx.options?.failRecordAttempts ?? 3;
  const delay = ctx.options?.retryDelayMs ?? 300;
  let rpcFailed = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { error } = await (processingAttempt
      ? ctx.admin.rpc("svc_fail_document_attempt", { p_user_id: ctx.userId, p_document_id: row.id, p_attempt: processingAttempt, p_error: code })
      : ctx.admin.rpc("svc_fail_document", { p_user_id: ctx.userId, p_document_id: row.id, p_error: code })
    ).abortSignal(requestSignal(budget));
    rpcFailed = error !== null;
    if (!error) break;
    log(ctx, "document.fail_rpc_failed", { documentId: row.id, attempt, sqlstate: error.code || null });
    if (attempt < attempts) {
      const wait = Math.min(delay * attempt, timeLeft(budget));
      if (wait <= 0) break; // out of time: the fresh read below decides; stale recovery covers the rest
      await sleep(wait);
    }
  }

  const current = await readDocument(ctx, row.id, budget);
  if ("failure" in current) {
    log(ctx, "document.fail_unconfirmed", { documentId: row.id });
    return fail("INTERNAL_ERROR");
  }
  const status = current.row.processing_status;
  if (status === "failed" || status === "ready" || status === "deleting") return ok(await settled(ctx, current.row, budget));

  log(ctx, "document.fail_not_recorded", { documentId: row.id, status, rpcFailed });
  return fail("INTERNAL_ERROR");
}

/**
 * The worker was terminated under SHARED memory pressure (MemoryPressureError): hand the document
 * back (processing → uploaded) with the token-scoped release, so the teacher can retry.
 *
 * - 'released' → uploaded, the object is kept, retryable SERVER_BUSY.
 * - 'cap_reached' (third time) → the database marked it failed SERVER_CAPACITY; settled() deletes
 *   the object only after a fresh read confirms `failed`.
 * - 'not_current', an error, or a lost response → a fresh owner-scoped read decides. Never the
 *   unscoped fail, never a deletion without a confirmed `failed`. Unconfirmable → retryable
 *   INTERNAL_ERROR with everything left untouched (stale recovery covers an orphaned attempt).
 */
async function releaseAfterMemoryPressure(ctx: ServiceContext, row: DocumentRow, processingAttempt: string, budget: Budget): Promise<ServiceResult<ProcessResult>> {
  const busy: ProcessResult = { documentId: row.id, status: "uploaded", error: safeError("SERVER_BUSY") };
  const attempts = 2; // the RPC is idempotent per token: a repeat after a lost response returns 'not_current'
  const delay = ctx.options?.retryDelayMs ?? 300;
  let outcome: "released" | "cap_reached" | "not_current" | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, error } = await ctx.admin
      .rpc("svc_release_document_processing", { p_user_id: ctx.userId, p_document_id: row.id, p_attempt: processingAttempt })
      .abortSignal(requestSignal(budget));
    if (!error && (data === "released" || data === "cap_reached" || data === "not_current")) {
      outcome = data;
      break;
    }
    log(ctx, "document.release_failed", { documentId: row.id, attempt, sqlstate: error?.code || (error ? null : "unexpected_reply") });
    const wait = Math.min(delay * attempt, timeLeft(budget));
    if (attempt === attempts || wait <= 0) break;
    await sleep(wait);
  }
  log(ctx, "document.memory_release", { documentId: row.id, outcome: outcome ?? "unconfirmed" });
  if (outcome === "released") return ok(busy);

  const current = await readDocument(ctx, row.id, budget);
  if ("failure" in current) {
    log(ctx, "document.release_unconfirmed", { documentId: row.id });
    return fail("INTERNAL_ERROR");
  }
  const now = current.row;
  // Only a release moves processing → uploaded: our release committed (its response was lost).
  if (now.processing_status === "uploaded") return ok(busy);
  if (now.processing_status === "processing" && now.processing_attempt === processingAttempt) {
    log(ctx, "document.release_not_recorded", { documentId: row.id });
    return fail("INTERNAL_ERROR");
  }
  // failed (cap reached, or recovered meanwhile) → cleanup after this confirmed read; ready;
  // deleting; or a newer attempt (→ PROCESSING_IN_PROGRESS). Nothing here touches that attempt.
  return ok(await settled(ctx, now, budget));
}

/** Result for a row that is not actionable right now (ready / failed / processing / deleting). */
async function settled(ctx: ServiceContext, row: DocumentRow, budget: Budget): Promise<ProcessResult> {
  switch (row.processing_status) {
    case "ready":
      return { documentId: row.id, status: "ready", extract: await readExtractSummary(ctx, row.id, budget) };
    case "failed": {
      const removed = await removeFailedObject(ctx, row, budget);
      return { documentId: row.id, status: "failed", error: storedErrorToSafe(row.processing_error), ...(removed ? {} : { cleanupPending: true }) };
    }
    case "processing":
      return { documentId: row.id, status: "processing", error: safeError("PROCESSING_IN_PROGRESS") };
    case "deleting":
      return { documentId: row.id, status: "deleting" };
    case "pending_upload":
      return { documentId: row.id, status: "pending_upload", error: safeError("UPLOAD_INCOMPLETE") };
    default:
      return { documentId: row.id, status: row.processing_status, error: safeError("STORAGE_UNAVAILABLE") };
  }
}

type DownloadOutcome = { bytes: Uint8Array; mimeType: string } | { failure: "missing" | "transient" };

/**
 * Service-role existence check, used only to confirm a `NoSuchKey` from the user-scoped download
 * (which Storage also returns for objects the caller cannot read). Missing only when Storage
 * answers `NoSuchKey` to the service role too; any other answer is "unknown".
 */
async function confirmObjectMissing(ctx: ServiceContext, row: DocumentRow, budget: Budget): Promise<"missing" | "present" | "unknown"> {
  if (timeLeft(budget) <= 0) return "unknown"; // exists() takes no AbortSignal
  try {
    const { data, error } = await ctx.admin.storage.from(SOURCE_BUCKET).exists(row.storage_path);
    if (data === true) return "present";
    if (data === false && classifyStorageError(error) === "not_found_candidate") return "missing";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Everything before extraction must leave room for extraction itself and for finalizing. */
const PRE_EXTRACTION_RESERVE_MS = PROCESSING_BUDGET.finalizeReserveMs + PROCESSING_BUDGET.minExtractionMs + WORKER_LIMITS.hardTimeoutGraceMs;

async function downloadObject(ctx: ServiceContext, row: DocumentRow, budget: Budget): Promise<DownloadOutcome> {
  const attempts = ctx.options?.downloadAttempts ?? 3;
  const delay = ctx.options?.retryDelayMs ?? 300;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (timeLeft(budget, PRE_EXTRACTION_RESERVE_MS) <= 0) break;
    try {
      // The signal aborts the real request, including reading the body (up to 10 MiB).
      const signal = requestSignal(budget, PRE_EXTRACTION_RESERVE_MS);
      const { data, error } = await ctx.db.storage.from(SOURCE_BUCKET).download(row.storage_path, {}, { signal });
      if (!error && data) {
        // Content-Type of the stored object (set at upload, allow-listed by the bucket); drop parameters.
        return { bytes: new Uint8Array(await data.arrayBuffer()), mimeType: data.type.split(";")[0].trim() };
      }
      if (classifyStorageError(error) === "not_found_candidate") {
        const confirmed = await confirmObjectMissing(ctx, row, budget);
        if (confirmed === "missing") return { failure: "missing" };
        // The object exists (or can't be checked) but this session can't read it: never treat
        // that as missing, never delete. Retry.
        log(ctx, "storage.download_unreadable", { documentId: row.id, attempt, confirmed });
      } else {
        log(ctx, "storage.download_failed", { documentId: row.id, attempt, error: storageErrorTag(error) });
      }
    } catch (error) {
      log(ctx, "storage.download_threw", { documentId: row.id, attempt, error: storageErrorTag(error) });
    }
    if (attempt < attempts) await sleep(Math.max(0, Math.min(delay * attempt, timeLeft(budget, PRE_EXTRACTION_RESERVE_MS))));
  }
  return { failure: "transient" };
}

export async function processDocument(ctx: ServiceContext, rawDocumentId: unknown): Promise<ServiceResult<ProcessResult>> {
  const id = documentIdSchema.safeParse(rawDocumentId);
  if (!id.success) return fail("INVALID_INPUT", ["documentId"]);

  const budget: Budget = { deadlineAt: ctx.deadlineAt ?? Date.now() + (ctx.options?.processingBudgetMs ?? PROCESSING_BUDGET.totalMs) };
  const busy = (documentId: string): ServiceResult<ProcessResult> => ok({ documentId, status: "uploaded", error: safeError("SERVER_BUSY") });

  const initial = await readDocument(ctx, id.data, budget);
  if ("failure" in initial) return fail(initial.failure); // missing, someone else's, or no session
  let row = initial.row;

  // 0. Abandoned `processing` row (killed request, or a failure that could not be recorded):
  //    record it as failed so the workflow completes. Fresh rows are left to their worker.
  if (row.processing_status === "processing") {
    const staleMs = ctx.options?.staleProcessingMs ?? DEFAULT_STALE_PROCESSING_MS;
    const age = Date.now() - Date.parse(row.updated_at);
    if (Number.isFinite(age) && age > staleMs) {
      log(ctx, "document.stale_processing", { documentId: row.id, ageMs: Math.round(age) });
      return failDocument(ctx, row, "INTERNAL_ERROR", budget);
    }
  }

  // 1. pending_upload → uploaded (object must exist; actual size from Storage metadata)
  if (row.processing_status === "pending_upload") {
    const { data: size, error } = await ctx.admin
      .rpc("svc_mark_document_verified", { p_user_id: ctx.userId, p_document_id: row.id })
      .abortSignal(requestSignal(budget));
    if (error) {
      if (error.code === "22023") {
        return ok({ documentId: row.id, status: "pending_upload", error: safeError("UPLOAD_INCOMPLETE") });
      }
      if (error.code === "TQ002" || error.code === "TQ003") {
        return failDocument(ctx, row, mapDatabaseError(error), budget);
      }
      if (error.code !== "P0002") {
        log(ctx, "document.verify_failed", { documentId: row.id, sqlstate: error.code ?? null });
        return fail("INTERNAL_ERROR");
      }
      // P0002: a concurrent request verified it (or it is no longer pending). Re-read.
      const current = await readDocument(ctx, row.id, budget);
      if ("failure" in current) return fail(current.failure);
      row = current.row;
    } else {
      row = { ...row, processing_status: "uploaded", file_size: Number(size) };
    }
  }

  if (row.processing_status !== "uploaded") return ok(await settled(ctx, row, budget));

  // 2. Download while still `uploaded` (retryable), and check the bytes against the DB row.
  const download = await downloadObject(ctx, row, budget);
  if ("failure" in download) {
    if (download.failure === "missing") return failDocument(ctx, row, "UPLOAD_MISSING", budget);
    return ok({ documentId: row.id, status: "uploaded", error: safeError("STORAGE_UNAVAILABLE") });
  }
  if (download.bytes.byteLength > EXTRACTION_LIMITS.maxInputBytes) return failDocument(ctx, row, "FILE_TOO_LARGE", budget);
  if (download.bytes.byteLength !== row.file_size) {
    // Short or altered read: never process partial bytes. Retry later.
    log(ctx, "storage.size_mismatch", { documentId: row.id, expected: row.file_size, actual: download.bytes.byteLength });
    return ok({ documentId: row.id, status: "uploaded", error: safeError("STORAGE_UNAVAILABLE") });
  }

  // 3. Reserve an extraction worker BEFORE claiming: if this server instance is saturated the
  //    document stays `uploaded` (retryable) instead of being failed for a server-side reason.
  //    The wait never eats into the time extraction and finalizing need.
  const slotWaitMs = Math.min(ctx.options?.slotWaitMs ?? 10_000, timeLeft(budget, PRE_EXTRACTION_RESERVE_MS));
  const slot = slotWaitMs >= 0 ? await acquireExtractionSlot(slotWaitMs) : null;
  if (!slot) {
    log(ctx, "extraction.busy", { documentId: row.id });
    return busy(row.id);
  }

  let result;
  let processingAttempt = "";
  try {
    // 3b. Memory admission, also before the claim: worker heap limits don't cover ArrayBuffers,
    //     so an instance that is already high on RSS must not start another extraction.
    const memory = hasMemoryForExtraction(ctx.options?.memory);
    if (!memory.ok) {
      log(ctx, "extraction.memory_busy", { documentId: row.id, rssMiB: Math.round(memory.rssBytes / 1048576) });
      return busy(row.id);
    }
    // 3c. Enough time left to extract and then save or record a failure? Otherwise don't claim.
    const extractionAvailableMs = timeLeft(budget, PROCESSING_BUDGET.finalizeReserveMs + WORKER_LIMITS.hardTimeoutGraceMs);
    if (extractionAvailableMs < PROCESSING_BUDGET.minExtractionMs) {
      log(ctx, "extraction.no_time", { documentId: row.id, leftMs: Math.round(extractionAvailableMs) });
      return busy(row.id);
    }

    // 4. Atomic claim: only one caller moves uploaded → processing, with a fresh attempt token.
    const claim = await ctx.admin
      .rpc("svc_claim_document_processing", { p_user_id: ctx.userId, p_document_id: row.id })
      .abortSignal(requestSignal(budget));
    const token = attemptSchema.safeParse(claim.data);
    if (claim.error || !token.success) {
      // Lost claim response or not claimable: never act without our own token. A fresh read
      // reports the row; an orphaned attempt is recovered once stale.
      if (!claim.error) log(ctx, "document.claim_unexpected_reply", { documentId: row.id });
      else if (claim.error.code !== "55000") log(ctx, "document.claim_failed", { documentId: row.id, sqlstate: claim.error.code ?? null });
      const current = await readDocument(ctx, row.id, budget);
      if ("failure" in current) return fail(current.failure);
      return ok(await settled(ctx, current.row, budget));
    }
    processingAttempt = token.data;
    row = { ...row, processing_status: "processing", processing_attempt: processingAttempt };

    // 5. Extract in an isolated worker thread (hard deadline, heap limits, RSS watchdog, no
    //    credentials). Content decides; the object's stored MIME type is checked too. Every
    //    worker failure (timeout, crash, invalid reply, out of memory) is an ExtractionError and
    //    is recorded below. The deadline never extends into the time reserved for finalizing.
    const deadlineMs = Math.min(ctx.options?.extractionDeadlineMs ?? EXTRACTION_LIMITS.defaultDeadlineMs, extractionAvailableMs);
    try {
      result = await extractDocumentIsolated(download.bytes, row.file_type, {
        mimeType: download.mimeType || null,
        deadlineMs: Math.max(1, Math.min(deadlineMs, timeLeft(budget, PROCESSING_BUDGET.finalizeReserveMs + WORKER_LIMITS.hardTimeoutGraceMs))),
        transfer: true, // the downloaded buffer is not used again here
        slot,
        workerUrl: ctx.options?.workerUrl,
        memory: ctx.options?.memory,
        admissionChecked: true, // checked above, before the claim (3b); never re-checked after it
      });
    } catch (error) {
      if (error instanceof MemoryPressureError) {
        // Shared process memory pressure, not this document: release it (bounded by the cap).
        log(ctx, "extraction.memory_pressure", {
          documentId: row.id,
          trigger: error.trigger,
          attribution: error.attribution,
          workerPeakMiB: error.workerPeakBytes === null ? null : Math.round(error.workerPeakBytes / 1048576),
          releasesSoFar: row.memory_release_count,
        });
        return releaseAfterMemoryPressure(ctx, row, processingAttempt, budget);
      }
      const code = error instanceof ExtractionError ? error.code : "INTERNAL_ERROR";
      log(ctx, "extraction.failed", { documentId: row.id, code, reason: error instanceof ExtractionError ? (error.reason ?? null) : "unexpected" });
      return failDocument(ctx, row, code, budget, processingAttempt);
    }
  } finally {
    slot.release();
  }

  // 5. Save (processing → ready). Text, page count and version are already bounded.
  const save = await ctx.admin
    .rpc("svc_save_document_extract_attempt", {
      p_user_id: ctx.userId,
      p_document_id: row.id,
      p_attempt: processingAttempt,
      p_text: result.text,
      p_page_count: result.page_count,
      p_is_truncated: result.is_truncated,
      p_extractor_version: result.extractor_version,
    })
    .abortSignal(requestSignal(budget));
  if (save.error) {
    log(ctx, "extract.save_failed", { documentId: row.id, sqlstate: save.error.code ?? null });
    if (save.error.code === "55000") {
      const current = await readDocument(ctx, row.id, budget);
      if ("failure" in current) return fail(current.failure);
      return ok(await settled(ctx, current.row, budget));
    }
    // An aborted save may still have committed: failDocument's fresh read then reports `ready`.
    return failDocument(ctx, row, "INTERNAL_ERROR", budget, processingAttempt);
  }

  return ok({
    documentId: row.id,
    status: "ready",
    extract: { charCount: result.text.length, pageCount: result.page_count, isTruncated: result.is_truncated },
  });
}

/**
 * processDocument for a request that still has to authenticate. The deadline is taken BEFORE
 * `authenticate()` runs, so time spent in the Auth round trip (getUser) is part of the same
 * budget. Used by ./index.ts; `budgetMs` is for tests.
 */
export async function processDocumentAuthenticated(
  authenticate: () => Promise<ServiceContext>,
  rawDocumentId: unknown,
  budgetMs: number = PROCESSING_BUDGET.totalMs,
): Promise<ServiceResult<ProcessResult>> {
  const deadlineAt = Date.now() + budgetMs;
  const ctx = await authenticate();
  return processDocument({ ...ctx, deadlineAt }, rawDocumentId);
}

// ------------------------------------------------------------------ status reads

export type DocumentStatusView = {
  documentId: string;
  fileName: string;
  fileType: "pdf" | "docx";
  fileSize: number;
  status: DocumentStatus;
  error?: SafeError;
  extract?: ExtractSummary;
  updatedAt: string;
  /**
   * Only while `pending_upload`: where the browser may (re)upload this file. The path belongs to
   * the signed-in teacher; Storage RLS (owner folder + pending row) is what authorizes the write.
   */
  upload?: { storagePath: string; contentType: string; maxBytes: number };
};

export type PresentationDocumentsView = {
  presentationId: string;
  title: string;
  presentationStatus: string;
  generationMode: string;
  settings: { grade: number; subject: string; language: string; theme: string; slideCount: number };
  createdAt: string;
  documents: DocumentStatusView[];
  quota: {
    attemptsToday: number;
    bytesToday: number;
    storedBytes: number;
    maxDailyAttempts: number;
    maxDailyBytes: number;
    maxStoredBytes: number;
    resetsAt: string;
  } | null;
};

export async function getPresentationDocuments(ctx: ReadContext, rawPresentationId: unknown): Promise<ServiceResult<PresentationDocumentsView>> {
  const id = presentationIdSchema.safeParse(rawPresentationId);
  if (!id.success) return fail("INVALID_INPUT", ["presentationId"]);

  const { data: presentation, error } = await ctx.db
    .from("presentations")
    .select("id, user_id, title, status, generation_mode, grade_level, subject, language, theme, slide_count, created_at")
    .eq("id", id.data)
    .maybeSingle();
  if (error) {
    if (error.code === "42501") return fail("UNAUTHENTICATED");
    log(ctx, "presentation.read_failed", { sqlstate: error.code ?? null });
    return fail("INTERNAL_ERROR");
  }
  if (!presentation || presentation.user_id !== ctx.userId) return fail("NOT_FOUND");

  const { data: docs, error: docsError } = await ctx.db
    .from("source_documents")
    .select("id, original_filename, file_type, file_size, processing_status, processing_error, updated_at, storage_path")
    .eq("presentation_id", id.data)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (docsError) {
    log(ctx, "documents.read_failed", { sqlstate: docsError.code ?? null });
    return fail("INTERNAL_ERROR");
  }

  const ids = (docs ?? []).map((doc) => doc.id as string);
  const extracts = new Map<string, ExtractSummary>();
  if (ids.length > 0) {
    const { data: rows } = await ctx.db
      .from("document_extracts")
      .select("source_document_id, char_count, page_count, is_truncated")
      .in("source_document_id", ids);
    for (const row of rows ?? []) {
      extracts.set(row.source_document_id as string, {
        charCount: Number(row.char_count),
        pageCount: (row.page_count as number | null) ?? null,
        isTruncated: Boolean(row.is_truncated),
      });
    }
  }

  const { data: quotaRows } = await ctx.db.rpc("my_upload_quota");
  const q = Array.isArray(quotaRows) ? quotaRows[0] : null;

  return ok({
    presentationId: presentation.id as string,
    title: presentation.title as string,
    presentationStatus: presentation.status as string,
    generationMode: presentation.generation_mode as string,
    settings: {
      grade: Number(presentation.grade_level),
      subject: presentation.subject as string,
      language: presentation.language as string,
      theme: presentation.theme as string,
      slideCount: Number(presentation.slide_count),
    },
    createdAt: presentation.created_at as string,
    documents: (docs ?? []).map((doc) => {
      const status = doc.processing_status as DocumentStatus;
      return {
        documentId: doc.id as string,
        fileName: doc.original_filename as string,
        fileType: doc.file_type as "pdf" | "docx",
        fileSize: Number(doc.file_size),
        status,
        ...(status === "failed" ? { error: storedErrorToSafe(doc.processing_error as string | null) } : {}),
        ...(extracts.has(doc.id as string) ? { extract: extracts.get(doc.id as string) } : {}),
        updatedAt: doc.updated_at as string,
        ...(status === "pending_upload"
          ? {
              upload: {
                storagePath: doc.storage_path as string,
                contentType: SUPPORTED_MIME_TYPES[doc.file_type as "pdf" | "docx"][0],
                maxBytes: EXTRACTION_LIMITS.maxInputBytes,
              },
            }
          : {}),
      };
    }),
    quota: q
      ? {
          attemptsToday: Number(q.attempts_today),
          bytesToday: Number(q.bytes_today),
          storedBytes: Number(q.stored_bytes),
          maxDailyAttempts: Number(q.max_daily_attempts),
          maxDailyBytes: Number(q.max_daily_bytes),
          maxStoredBytes: Number(q.max_stored_bytes),
          resetsAt: String(q.resets_at),
        }
      : null,
  });
}
