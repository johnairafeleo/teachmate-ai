import { z } from "zod";

import { EXTRACTION_LIMITS } from "../limits.ts";

/**
 * Messages between the request thread and an extraction worker. The parent sends only bytes and
 * plain parameters (never clients, credentials or env); the worker answers with exactly one
 * message, which the parent validates before using.
 */

export type WorkerRequest = {
  /** Owned by the worker after a transfer. */
  bytes: ArrayBuffer;
  kind: "pdf" | "docx";
  mimeType: string | null;
  /** Cooperative in-worker deadline; the parent enforces a hard one on top. */
  deadlineMs: number;
};

const ERROR_CODES = [
  "UNSUPPORTED_TYPE", "EMPTY_FILE", "FILE_TOO_LARGE", "TYPE_MISMATCH", "MALFORMED_DOCUMENT", "ENCRYPTED_DOCUMENT",
  "MACRO_ENABLED", "NOT_A_WORD_DOCUMENT", "UNSAFE_CONTENT", "LIMITS_EXCEEDED", "NO_TEXT", "TIMEOUT", "INTERNAL_ERROR",
] as const;

const ERROR_REASONS = [
  "zip_entries", "zip_total_size", "zip_ratio", "zip_entry_size", "zip64", "zip_structure", "zip_crc", "zip_method",
  "xml_doctype", "xml_markup", "xml_encoding", "xml_root", "content_types", "pdf_parse", "pdf_password", "deadline", "unexpected",
] as const;

/** The only shapes a worker may send. Anything else is a protocol violation. */
export const workerResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: z.object({
      text: z.string().max(EXTRACTION_LIMITS.maxOutputChars),
      page_count: z.number().int().min(0).max(EXTRACTION_LIMITS.maxPdfPages).nullable(),
      total_pages: z.number().int().min(0).nullable(),
      is_truncated: z.boolean(),
      extractor_version: z.string().min(1).max(40),
    }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum(ERROR_CODES),
    reason: z.enum(ERROR_REASONS).optional(),
  }).strict(),
]);

export type WorkerResponse = z.infer<typeof workerResponseSchema>;
