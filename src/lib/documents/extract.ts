import { ExtractionError } from "./errors.ts";
import { extractDocxText } from "./extract-docx.ts";
import { extractPdfText, PDFJS_VERSION_PROMISE } from "./extract-pdf.ts";
import { EXTRACTION_LIMITS, SUPPORTED_MIME_TYPES } from "./limits.ts";
import { countMeaningfulChars, normalizeExtractedText, truncateText } from "./normalize.ts";
import { oleLooksEncrypted, sniffKind } from "./sniff.ts";

/**
 * Extraction engine entry point. Pure: no Supabase, no Next.js, no network, no filesystem.
 * Takes bytes plus the type the server already recorded for the document, and returns text
 * ready for public.document_extracts — or throws an ExtractionError with a fixed code.
 */

export type DocumentKind = keyof typeof SUPPORTED_MIME_TYPES;

export type ExtractionResult = {
  text: string;
  /** Pages actually read (PDF, ≤ 50); null for DOCX, which has no fixed pages. */
  page_count: number | null;
  /** Pages in the file (PDF); null for DOCX. Lets the UI say "first 50 of 120 pages". */
  total_pages: number | null;
  is_truncated: boolean;
  /** ≤ 40 characters (document_extracts.extractor_version). */
  extractor_version: string;
};

export type ExtractOptions = {
  /** Milliseconds from now; defaults to 20 s. */
  deadlineMs?: number;
  /** MIME type recorded with the stored object, if known. Checked, never trusted on its own. */
  mimeType?: string | null;
};

export const EXTRACTOR_VERSION = { pdf: "tm-pdf-1", docx: "tm-docx-1" } as const;

export async function extractDocument(
  input: Uint8Array,
  declaredKind: string,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  try {
    if (declaredKind !== "pdf" && declaredKind !== "docx") throw new ExtractionError("UNSUPPORTED_TYPE");
    const kind: DocumentKind = declaredKind;
    if (!(input instanceof Uint8Array)) throw new ExtractionError("UNSUPPORTED_TYPE");
    if (input.byteLength === 0) throw new ExtractionError("EMPTY_FILE");
    if (input.byteLength > EXTRACTION_LIMITS.maxInputBytes) throw new ExtractionError("FILE_TOO_LARGE");

    const mime = options.mimeType?.trim().toLowerCase();
    if (mime && !(SUPPORTED_MIME_TYPES[kind] as readonly string[]).includes(mime)) {
      throw new ExtractionError("TYPE_MISMATCH");
    }

    const sniffed = sniffKind(input);
    const deadlineAt = Date.now() + Math.max(1, options.deadlineMs ?? EXTRACTION_LIMITS.defaultDeadlineMs);

    let raw: string;
    let truncated: boolean;
    let pageCount: number | null = null;
    let totalPages: number | null = null;
    let version: string;

    if (kind === "pdf") {
      if (sniffed !== "pdf") throw new ExtractionError("TYPE_MISMATCH");
      const pdf = await extractPdfText(input, deadlineAt);
      raw = pdf.raw;
      truncated = pdf.truncated;
      pageCount = pdf.pagesRead;
      totalPages = pdf.totalPages;
      version = `${EXTRACTOR_VERSION.pdf}+pdfjs-${await PDFJS_VERSION_PROMISE}`;
    } else {
      if (sniffed === "ole") {
        // Office-encrypted .docx files are OLE containers; anything else here is a legacy .doc.
        throw new ExtractionError(oleLooksEncrypted(input) ? "ENCRYPTED_DOCUMENT" : "TYPE_MISMATCH");
      }
      if (sniffed !== "zip") throw new ExtractionError("TYPE_MISMATCH");
      const docx = extractDocxText(input, deadlineAt);
      raw = docx.raw;
      truncated = docx.truncated;
      version = `${EXTRACTOR_VERSION.docx}+fflate-0.8.3`;
    }

    const normalized = normalizeExtractedText(raw);
    if (countMeaningfulChars(normalized) < EXTRACTION_LIMITS.minMeaningfulChars) throw new ExtractionError("NO_TEXT");
    const limited = truncateText(normalized, EXTRACTION_LIMITS.maxOutputChars);

    return {
      text: limited.text,
      page_count: pageCount,
      total_pages: totalPages,
      is_truncated: truncated || limited.truncated,
      extractor_version: version.slice(0, 40),
    };
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    // Never leak parser internals (messages can contain document bytes or paths).
    throw new ExtractionError("INTERNAL_ERROR", "unexpected");
  }
}

export { ExtractionError, isExtractionError, extractionErrorMessage } from "./errors.ts";
export type { ExtractionErrorCode, ExtractionErrorReason } from "./errors.ts";
export { EXTRACTION_LIMITS } from "./limits.ts";
