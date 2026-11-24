/**
 * Fixed, user-safe extraction errors. Parser messages and stack traces never leave this module:
 * callers get a code, fixed copy, and (for logs only) a reason from a fixed list.
 */

const MESSAGES = {
  UNSUPPORTED_TYPE: "Only PDF and DOCX files are supported.",
  EMPTY_FILE: "This file is empty.",
  FILE_TOO_LARGE: "This file is larger than 10 MB.",
  TYPE_MISMATCH: "This file’s contents don’t match its file type.",
  MALFORMED_DOCUMENT: "This file is damaged or isn’t a valid PDF or Word document.",
  ENCRYPTED_DOCUMENT: "This file is password-protected. Remove the password and upload it again.",
  MACRO_ENABLED: "Macro-enabled Word files aren’t supported. Save it as a regular .docx file and try again.",
  NOT_A_WORD_DOCUMENT: "This file isn’t a regular Word document (for example, it’s a spreadsheet, slideshow or template).",
  UNSAFE_CONTENT: "This file contains content we can’t safely process.",
  LIMITS_EXCEEDED: "This file is too complex or expands too much to process safely.",
  NO_TEXT: "We couldn’t find any selectable text in this file. Scanned documents aren’t supported yet.",
  TIMEOUT: "This file took too long to read. Try a smaller or simpler file.",
  INTERNAL_ERROR: "Something went wrong while reading this file. Please try again.",
} as const;

export type ExtractionErrorCode = keyof typeof MESSAGES;

/** Fixed reasons for server logs only — never shown to users, never contain document data. */
export type ExtractionErrorReason =
  | "zip_entries"
  | "zip_total_size"
  | "zip_ratio"
  | "zip_entry_size"
  | "zip64"
  | "zip_structure"
  | "zip_crc"
  | "zip_method"
  | "xml_doctype"
  | "xml_markup"
  | "xml_encoding"
  | "xml_root"
  | "content_types"
  | "pdf_parse"
  | "pdf_password"
  | "deadline"
  | "unexpected"
  // isolated (worker_threads) extraction
  | "worker_start"
  | "worker_timeout"
  | "worker_crash"
  | "worker_exit"
  | "worker_memory"
  | "worker_protocol"
  | "worker_busy"
  | "aborted"
  // process RSS watchdog (isolated-extract.ts → MEMORY_LIMITS)
  | "process_memory"
  | "memory_growth"
  | "memory_busy";

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  readonly reason: ExtractionErrorReason | undefined;

  constructor(code: ExtractionErrorCode, reason?: ExtractionErrorReason) {
    super(MESSAGES[code]);
    this.name = "ExtractionError";
    this.code = code;
    this.reason = reason;
  }
}

export function isExtractionError(error: unknown): error is ExtractionError {
  return error instanceof ExtractionError;
}

export function extractionErrorMessage(code: ExtractionErrorCode): string {
  return MESSAGES[code];
}

/** Cooperative deadline check for synchronous loops (not CPU isolation; see README notes). */
export function assertBeforeDeadline(deadlineAt: number): void {
  if (Date.now() > deadlineAt) throw new ExtractionError("TIMEOUT", "deadline");
}
