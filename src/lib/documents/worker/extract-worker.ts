/**
 * Extraction worker (node:worker_threads). Runs ONE extraction and replies with ONE message.
 * The parent terminates it right after (or when its hard deadline expires), so CPU-bound PDF.js /
 * DOCX parsing never blocks the request thread and cannot keep running in the background.
 *
 * The worker gets no credentials: it is started with an empty environment and receives only the
 * file bytes plus plain parameters. It imports nothing but the pure extraction engine.
 */
import { parentPort } from "node:worker_threads";

import { ExtractionError } from "../errors.ts";
import { extractDocument } from "../extract.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

// PDF.js rejects some internal promises nobody observes (corrupt page dictionaries). Inside the
// worker that can only affect this one job: never crash the thread for it, never log content.
process.on("unhandledRejection", () => {});

const port = parentPort;
if (!port) throw new Error("extract-worker must run as a worker thread");

port.once("message", async (request: WorkerRequest) => {
  let response: WorkerResponse;
  try {
    const result = await extractDocument(new Uint8Array(request.bytes), request.kind, {
      mimeType: request.mimeType,
      deadlineMs: request.deadlineMs,
    });
    response = { ok: true, result };
  } catch (error) {
    response =
      error instanceof ExtractionError
        ? { ok: false, code: error.code, ...(isPlainReason(error.reason) ? { reason: error.reason } : {}) }
        : { ok: false, code: "INTERNAL_ERROR", reason: "unexpected" };
  }
  port.postMessage(response);
});

function isPlainReason(reason: string | undefined): reason is NonNullable<Extract<WorkerResponse, { ok: false }>["reason"]> {
  return typeof reason === "string" && !reason.startsWith("worker_") && reason !== "aborted";
}
