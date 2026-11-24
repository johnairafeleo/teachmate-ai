import type { ExtractionErrorCode } from "../../documents/errors.ts";
import { extractionErrorMessage } from "../../documents/errors.ts";

/**
 * Fixed, user-safe error codes for the document service. Raw Postgres, Supabase, Storage and
 * parser messages never leave the server; only these codes and messages do.
 */

const SERVICE_MESSAGES = {
  INVALID_INPUT: "Some details are missing or invalid. Check the form and try again.",
  UNAUTHENTICATED: "Your session has ended. Please sign in again.",
  NOT_FOUND: "We couldn’t find that presentation or file.",
  QUOTA_DAILY_UPLOADS: "You’ve reached today’s upload limit (20 files). Try again tomorrow.",
  QUOTA_DAILY_BYTES: "You’ve reached today’s upload size limit (200 MB). Try again tomorrow.",
  QUOTA_STORAGE: "Your storage is full (150 MB). Remove some uploaded files and try again.",
  DOCUMENT_LIMIT: "This presentation already has the maximum number of files or upload attempts.",
  PRESENTATION_LOCKED: "Files can’t be added to this presentation right now.",
  UPLOAD_INCOMPLETE: "The upload hasn’t finished yet. Wait a moment and try again.",
  UPLOAD_MISSING: "The uploaded file could not be found. Please upload it again.",
  STORAGE_UNAVAILABLE: "We couldn’t read the uploaded file right now. Please try again in a moment.",
  PROCESSING_IN_PROGRESS: "This file is still being processed.",
  SERVER_BUSY: "Our servers are busy right now, so this file wasn’t read yet. Your upload is safe — use Try again in a moment.",
  // Permanent: the file was handed back twice after server memory pressure and failed a third time.
  SERVER_CAPACITY: "We couldn’t read this file because our servers stayed too busy after several attempts. Please upload it again later.",
  // Overrides the extraction engine's file-specific wording for service-level failures.
  INTERNAL_ERROR: "Something went wrong on our side. Please try again in a moment.",
} as const;

export type ServiceOnlyErrorCode = keyof typeof SERVICE_MESSAGES;
export type DocumentErrorCode = ServiceOnlyErrorCode | ExtractionErrorCode;

/** Conditions where trying the same request again later can succeed. */
const RETRYABLE = new Set<DocumentErrorCode>(["UPLOAD_INCOMPLETE", "STORAGE_UNAVAILABLE", "PROCESSING_IN_PROGRESS", "SERVER_BUSY", "INTERNAL_ERROR"]);

export type SafeError = { code: DocumentErrorCode; message: string; retryable: boolean; fields?: string[] };

const EXTRACTION_CODES = new Set<string>([
  "UNSUPPORTED_TYPE", "EMPTY_FILE", "FILE_TOO_LARGE", "TYPE_MISMATCH", "MALFORMED_DOCUMENT", "ENCRYPTED_DOCUMENT",
  "MACRO_ENABLED", "NOT_A_WORD_DOCUMENT", "UNSAFE_CONTENT", "LIMITS_EXCEEDED", "NO_TEXT", "TIMEOUT", "INTERNAL_ERROR",
]);

export function isDocumentErrorCode(value: unknown): value is DocumentErrorCode {
  return typeof value === "string" && (Object.hasOwn(SERVICE_MESSAGES, value) || EXTRACTION_CODES.has(value));
}

export function safeError(code: DocumentErrorCode, fields?: string[]): SafeError {
  const message = Object.hasOwn(SERVICE_MESSAGES, code)
    ? SERVICE_MESSAGES[code as ServiceOnlyErrorCode]
    : extractionErrorMessage(code as ExtractionErrorCode);
  return { code, message, retryable: RETRYABLE.has(code), ...(fields?.length ? { fields } : {}) };
}

/** processing_error stores only our codes; anything else (legacy/manual) maps to a generic error. */
export function storedErrorToSafe(stored: string | null): SafeError {
  return safeError(isDocumentErrorCode(stored) ? stored : "INTERNAL_ERROR");
}

type DbError = { code?: string | null; message?: string | null };

/**
 * Map a PostgREST/Postgres error to a fixed code. Only SQLSTATEs (and the fixed messages our own
 * triggers raise) are inspected; the raw message is never returned.
 */
export function mapDatabaseError(error: DbError): DocumentErrorCode {
  const message = error.message ?? "";
  switch (error.code) {
    case "TQ001":
      return "QUOTA_DAILY_UPLOADS";
    case "TQ002":
      return "QUOTA_DAILY_BYTES";
    case "TQ003":
      return "QUOTA_STORAGE";
    case "42501":
      return "UNAUTHENTICATED";
    case "23503":
      return "NOT_FOUND";
    case "55000":
      return "PRESENTATION_LOCKED";
    case "23514":
      return /at most 3 source documents|too many upload attempts/.test(message) ? "DOCUMENT_LIMIT" : "INVALID_INPUT";
    case "22023":
    case "22P02":
    case "22001":
    case "23502":
      return "INVALID_INPUT";
    default:
      return "INTERNAL_ERROR";
  }
}
