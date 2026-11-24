/**
 * Pure state for the materials upload workflow (no React, no network) — unit-tested with
 * node:test. The server decides every document outcome; this module only maps server results
 * to what the teacher sees and which retry (if any) is offered. It never invents success.
 */
import type { SafeError } from "../../../lib/server/documents/errors.ts";
import type { DocumentStatusView, ProcessResult } from "../../../lib/server/documents/service.ts";

export type FilePhase =
  | "waiting" // registered, upload not started
  | "uploading"
  | "upload_failed"
  | "processing"
  | "ready"
  | "failed"
  | "needs_retry"; // the server said "try again later"

/** Which retry the UI may offer. Only ever set for retryable conditions. */
export type RetryKind = "upload" | "process" | null;

export type SafeMessage = Pick<SafeError, "code" | "message" | "retryable">;

export type FileProgress = {
  key: string;
  name: string;
  size: number;
  documentId?: string;
  phase: FilePhase;
  /** Bytes sent to Storage, from real XHR progress events (never simulated). */
  uploadedBytes: number;
  error?: SafeMessage;
  retry: RetryKind;
};

export type RunPhase = "idle" | "creating" | "active" | "draft_failed";

export type UploadRun = {
  phase: RunPhase;
  presentationId?: string;
  files: FileProgress[];
  /** Form-level error from draft creation (quota, invalid input, session). */
  formError?: SafeMessage;
  formErrorFields?: string[];
};

export type UploadAction =
  | { type: "start"; files: { key: string; name: string; size: number }[] }
  | { type: "draft_created"; presentationId: string; documentIds: string[] }
  | { type: "draft_failed"; error: SafeMessage; fields?: string[] }
  | { type: "upload_started"; key: string }
  | { type: "upload_progress"; key: string; loaded: number }
  | { type: "upload_finished"; key: string }
  | { type: "upload_failed"; key: string; error: SafeMessage }
  | { type: "process_started"; key: string }
  | { type: "process_result"; key: string; result: { ok: true; data: ProcessResult } | { ok: false; error: SafeMessage } }
  | { type: "status_sync"; documents: Pick<DocumentStatusView, "documentId" | "status" | "error">[] }
  | { type: "reset" };

export const INITIAL_RUN: UploadRun = { phase: "idle", files: [] };

/** Map a server ProcessResult (or request-level error) to a UI phase + retry. */
export function phaseFromProcessResult(result: { ok: true; data: ProcessResult } | { ok: false; error: SafeMessage }): Pick<FileProgress, "phase" | "error" | "retry"> {
  if (!result.ok) {
    return result.error.retryable
      ? { phase: "needs_retry", error: pick(result.error), retry: "process" }
      : { phase: "failed", error: pick(result.error), retry: null };
  }
  const { status, error } = result.data;
  switch (status) {
    case "ready":
      return { phase: "ready", error: undefined, retry: null };
    case "failed":
    case "deleting":
      // A recorded failure is final for this upload; the teacher uploads a new file instead.
      return { phase: "failed", error: error ? pick(error) : undefined, retry: null };
    case "processing":
      return { phase: "processing", error: undefined, retry: null }; // still running: poll, don't retry
    case "pending_upload":
      // The server found no uploaded object: the upload itself must be repeated.
      return { phase: "needs_retry", error: error ? pick(error) : undefined, retry: "upload" };
    case "uploaded":
      return { phase: "needs_retry", error: error ? pick(error) : undefined, retry: error?.retryable === false ? null : "process" };
  }
}

/** Map a status-page document row to a UI phase + retry (no file in memory → upload retry = re-select). */
export function phaseFromStatusView(doc: Pick<DocumentStatusView, "status" | "error">): Pick<FileProgress, "phase" | "error" | "retry"> {
  switch (doc.status) {
    case "ready":
      return { phase: "ready", error: undefined, retry: null };
    case "failed":
    case "deleting":
      return { phase: "failed", error: doc.error ? pick(doc.error) : undefined, retry: null };
    case "processing":
      return { phase: "processing", error: undefined, retry: null };
    case "pending_upload":
      return { phase: "waiting", error: undefined, retry: "upload" };
    case "uploaded":
      return { phase: "needs_retry", error: undefined, retry: "process" };
  }
}

const pick = (error: SafeMessage): SafeMessage => ({ code: error.code, message: error.message, retryable: error.retryable });

export const isTerminal = (file: Pick<FileProgress, "phase">) => file.phase === "ready" || file.phase === "failed";
export const isBusy = (file: Pick<FileProgress, "phase">) => file.phase === "uploading" || file.phase === "processing";
export const needsPolling = (files: readonly Pick<FileProgress, "phase">[]) => files.some((file) => file.phase === "processing");
export const isRunBusy = (run: UploadRun) => run.phase === "creating" || (run.phase === "active" && run.files.some(isBusy));
/** Duplicate-submit guard: a new run may only start from idle or after a failed draft. */
export const canStartRun = (run: UploadRun) => run.phase === "idle" || run.phase === "draft_failed";

function updateFile(run: UploadRun, key: string, patch: Partial<FileProgress>): UploadRun {
  return { ...run, files: run.files.map((file) => (file.key === key ? { ...file, ...patch } : file)) };
}

export function uploadReducer(run: UploadRun, action: UploadAction): UploadRun {
  switch (action.type) {
    case "start":
      if (!canStartRun(run)) return run; // ignore duplicate submits
      return {
        phase: "creating",
        files: action.files.map((file) => ({ ...file, phase: "waiting", uploadedBytes: 0, retry: null })),
      };
    case "draft_created":
      if (run.phase !== "creating" || action.documentIds.length !== run.files.length) return run;
      return {
        ...run,
        phase: "active",
        presentationId: action.presentationId,
        files: run.files.map((file, index) => ({ ...file, documentId: action.documentIds[index] })),
      };
    case "draft_failed":
      if (run.phase !== "creating") return run;
      return { phase: "draft_failed", files: [], formError: pick(action.error), formErrorFields: action.fields };
    case "upload_started":
      return updateFile(run, action.key, { phase: "uploading", uploadedBytes: 0, error: undefined, retry: null });
    case "upload_progress": {
      const file = run.files.find((f) => f.key === action.key);
      if (!file || file.phase !== "uploading") return run;
      return updateFile(run, action.key, { uploadedBytes: Math.min(file.size, Math.max(file.uploadedBytes, action.loaded)) });
    }
    case "upload_finished":
      return updateFile(run, action.key, { phase: "processing", uploadedBytes: run.files.find((f) => f.key === action.key)?.size ?? 0 });
    case "upload_failed":
      return updateFile(run, action.key, { phase: action.error.retryable ? "upload_failed" : "failed", error: pick(action.error), retry: action.error.retryable ? "upload" : null });
    case "process_started":
      return updateFile(run, action.key, { phase: "processing", error: undefined, retry: null });
    case "process_result":
      return updateFile(run, action.key, phaseFromProcessResult(action.result));
    case "status_sync": {
      // Only files the client believes are processing are updated from the server's view.
      const byId = new Map(action.documents.map((doc) => [doc.documentId, doc]));
      return {
        ...run,
        files: run.files.map((file) => {
          const doc = file.documentId ? byId.get(file.documentId) : undefined;
          if (!doc || file.phase !== "processing") return file;
          const next = phaseFromStatusView(doc);
          return next.phase === "processing" ? file : { ...file, ...next };
        }),
      };
    }
    case "reset":
      return INITIAL_RUN;
  }
}

/** One-line summary for the polite live region. */
export function runSummary(files: readonly Pick<FileProgress, "phase">[]): string {
  if (files.length === 0) return "";
  const count = (phase: FilePhase) => files.filter((file) => file.phase === phase).length;
  const parts = [
    `${count("ready")} of ${files.length} ready`,
    count("uploading") ? `${count("uploading")} uploading` : "",
    count("processing") ? `${count("processing")} reading` : "",
    count("failed") ? `${count("failed")} failed` : "",
    count("needs_retry") + count("upload_failed") ? `${count("needs_retry") + count("upload_failed")} need a retry` : "",
  ];
  return parts.filter(Boolean).join(", ") + ".";
}

/** Client-side title check mirroring the server schema (the server re-validates). */
export function validateTitle(raw: string): string | undefined {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return "Enter a presentation title.";
  if (title.length > 200) return "Keep the title to 200 characters or fewer.";
  return undefined;
}

/** Browser MIME type as a hint only: send it when it is one we accept, otherwise let the server decide. */
export function mimeHint(kind: "pdf" | "docx", browserType: string): string {
  const accepted = kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return browserType.toLowerCase() === accepted ? accepted : "";
}
