import { getResolvedPDFJS } from "unpdf";

import { ExtractionError } from "./errors.ts";
import { EXTRACTION_LIMITS } from "./limits.ts";

/**
 * PDF text via unpdf's serverless PDF.js build (6.4.299, bundled — no eval/new Function code
 * paths; CVE-2024-4367 was fixed in 4.2.67).
 *
 * - Opens the document, then reads pages 1..min(numPages, 50) one at a time; later pages are
 *   never parsed. Stops early once enough raw text is collected.
 * - Text only: no rendering, no font loading, no system fonts, no remote fetches, no XFA, no WASM
 *   image decoders, no range/stream loading.
 * - The deadline is a timer per awaited step plus a check between pages; on expiry the loading
 *   task is destroyed. This is NOT CPU isolation: PDF.js runs on this thread (no worker in Node),
 *   so a step that never yields cannot be interrupted. See TASK 005.7 (worker isolation).
 */

type TextItemLike = { str?: unknown; hasEOL?: unknown };

export const PDFJS_VERSION_PROMISE = getResolvedPDFJS().then((pdfjs) => String(pdfjs.version));

export async function extractPdfText(
  bytes: Uint8Array,
  deadlineAt: number,
): Promise<{ raw: string; pagesRead: number; totalPages: number; truncated: boolean }> {
  const { getDocument } = await getResolvedPDFJS();

  const task = getDocument({
    data: bytes.slice(), // PDF.js may transfer/detach the buffer; never hand it the caller's copy
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWasm: false,
    useWorkerFetch: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: false,
    verbosity: 0, // errors only; PDF.js warnings would otherwise be printed to the console
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = <T>(promise: Promise<T>): Promise<T> => {
    // PDF.js may reject a promise after we stop waiting for it (deadline, destroy()). Always
    // observe it so a late rejection can never become an unhandled rejection in the process.
    promise.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return reject(new ExtractionError("TIMEOUT", "deadline"));
      timer = setTimeout(() => reject(new ExtractionError("TIMEOUT", "deadline")), remaining);
      promise.then(
        (value) => {
          clearTimeout(timer);
          // A step that blocked the thread past the deadline resolves before the timer can run:
          // reject its late result instead of continuing.
          if (Date.now() > deadlineAt) reject(new ExtractionError("TIMEOUT", "deadline"));
          else resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };

  try {
    const doc = await step(task.promise);
    const totalPages = doc.numPages;
    const lastPage = Math.min(totalPages, EXTRACTION_LIMITS.maxPdfPages);
    let raw = "";
    let pagesRead = 0;
    let truncated = totalPages > EXTRACTION_LIMITS.maxPdfPages;

    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber++) {
      const page = await step(doc.getPage(pageNumber));
      const content = await step(page.getTextContent());
      for (const item of content.items as TextItemLike[]) {
        if (typeof item.str === "string") raw += item.str;
        if (item.hasEOL === true) raw += "\n";
      }
      raw += "\n\n";
      page.cleanup();
      pagesRead = pageNumber;
      if (raw.length > EXTRACTION_LIMITS.maxRawChars) {
        if (pageNumber < totalPages) truncated = true;
        break;
      }
    }
    return { raw, pagesRead, totalPages, truncated };
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") throw new ExtractionError("ENCRYPTED_DOCUMENT", "pdf_password");
    throw new ExtractionError("MALFORMED_DOCUMENT", "pdf_parse");
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => {});
  }
}
