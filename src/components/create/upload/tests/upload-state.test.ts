import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyUploadResponse } from "../storage-upload.ts";
import {
  canStartRun,
  INITIAL_RUN,
  isRunBusy,
  mimeHint,
  needsPolling,
  phaseFromProcessResult,
  phaseFromStatusView,
  runSummary,
  uploadReducer,
  validateTitle,
  type UploadRun,
} from "../upload-state.ts";

const err = (code: string, retryable: boolean) => ({ code, message: `msg ${code}`, retryable }) as never;
const three = [
  { key: "a", name: "a.pdf", size: 1000 },
  { key: "b", name: "b.docx", size: 2000 },
  { key: "c", name: "c.pdf", size: 3000 },
];
const active = (): UploadRun => {
  let run = uploadReducer(INITIAL_RUN, { type: "start", files: three });
  run = uploadReducer(run, { type: "draft_created", presentationId: "p1", documentIds: ["d1", "d2", "d3"] });
  return run;
};

describe("Materials mode title (client mirror of the server rule)", () => {
  test("required, trimmed, at most 200 characters", () => {
    assert.equal(validateTitle(""), "Enter a presentation title.");
    assert.equal(validateTitle("   \n\t "), "Enter a presentation title.");
    assert.equal(validateTitle("x".repeat(201)), "Keep the title to 200 characters or fewer.");
    assert.equal(validateTitle("  Parts   of a Plant  "), undefined);
  });
});

describe("duplicate submit prevention", () => {
  test("a second start while a run is in progress is ignored", () => {
    const first = uploadReducer(INITIAL_RUN, { type: "start", files: three });
    assert.equal(first.phase, "creating");
    assert.equal(canStartRun(first), false);
    assert.equal(uploadReducer(first, { type: "start", files: [three[0]] }), first);
    const running = active();
    assert.equal(canStartRun(running), false);
    assert.equal(uploadReducer(running, { type: "start", files: three }), running);
  });

  test("a failed draft can be submitted again", () => {
    const failed = uploadReducer(uploadReducer(INITIAL_RUN, { type: "start", files: three }), { type: "draft_failed", error: err("QUOTA_DAILY_UPLOADS", false) });
    assert.equal(failed.phase, "draft_failed");
    assert.equal(failed.formError?.code, "QUOTA_DAILY_UPLOADS");
    assert.equal(canStartRun(failed), true);
  });

  test("draft ids must match the files one-to-one", () => {
    const creating = uploadReducer(INITIAL_RUN, { type: "start", files: three });
    assert.equal(uploadReducer(creating, { type: "draft_created", presentationId: "p", documentIds: ["only-one"] }), creating);
    const run = active();
    assert.deepEqual(run.files.map((f) => f.documentId), ["d1", "d2", "d3"]);
    assert.ok(run.files.every((f) => f.phase === "waiting" && f.uploadedBytes === 0));
  });
});

describe("upload progress (real bytes only)", () => {
  test("progress is monotonic, capped at the file size, and only while uploading", () => {
    let run = active();
    run = uploadReducer(run, { type: "upload_progress", key: "a", loaded: 500 });
    assert.equal(run.files[0].uploadedBytes, 0, "ignored before upload_started");
    run = uploadReducer(run, { type: "upload_started", key: "a" });
    run = uploadReducer(run, { type: "upload_progress", key: "a", loaded: 600 });
    run = uploadReducer(run, { type: "upload_progress", key: "a", loaded: 300 });
    assert.equal(run.files[0].uploadedBytes, 600, "never goes backwards");
    run = uploadReducer(run, { type: "upload_progress", key: "a", loaded: 99_999 });
    assert.equal(run.files[0].uploadedBytes, 1000, "capped");
    assert.equal(isRunBusy(run), true);
  });

  test("a finished upload goes to processing, never straight to ready", () => {
    let run = uploadReducer(active(), { type: "upload_started", key: "a" });
    run = uploadReducer(run, { type: "upload_finished", key: "a" });
    assert.equal(run.files[0].phase, "processing");
    assert.equal(needsPolling(run.files), true);
  });
});

describe("partial failures and retry eligibility", () => {
  test("retryable upload failure offers an upload retry; permanent does not", () => {
    let run = uploadReducer(active(), { type: "upload_started", key: "b" });
    run = uploadReducer(run, { type: "upload_failed", key: "b", error: err("NETWORK", true) });
    assert.deepEqual([run.files[1].phase, run.files[1].retry], ["upload_failed", "upload"]);
    run = uploadReducer(run, { type: "upload_failed", key: "c", error: err("TOO_LARGE", false) });
    assert.deepEqual([run.files[2].phase, run.files[2].retry], ["failed", null]);
  });

  test("mixed outcome summary", () => {
    let run = active();
    run = uploadReducer(run, { type: "process_result", key: "a", result: { ok: true, data: { documentId: "d1", status: "ready" } } });
    run = uploadReducer(run, { type: "upload_failed", key: "b", error: err("NETWORK", true) });
    run = uploadReducer(run, { type: "process_result", key: "c", result: { ok: true, data: { documentId: "d3", status: "failed", error: err("MALFORMED_DOCUMENT", false) } } });
    assert.equal(runSummary(run.files), "1 of 3 ready, 1 failed, 1 need a retry.");
    assert.equal(isRunBusy(run), false);
  });
});

describe("server results → UI (the server decides; nothing is invented)", () => {
  test("only status ready produces ready", () => {
    const cases = [
      [{ ok: true, data: { documentId: "d", status: "ready" } }, "ready", null],
      [{ ok: true, data: { documentId: "d", status: "failed", error: err("NO_TEXT", false) } }, "failed", null],
      [{ ok: true, data: { documentId: "d", status: "processing", error: err("PROCESSING_IN_PROGRESS", true) } }, "processing", null],
      [{ ok: true, data: { documentId: "d", status: "pending_upload", error: err("UPLOAD_INCOMPLETE", true) } }, "needs_retry", "upload"],
      [{ ok: true, data: { documentId: "d", status: "uploaded", error: err("STORAGE_UNAVAILABLE", true) } }, "needs_retry", "process"],
      [{ ok: false, error: err("INTERNAL_ERROR", true) }, "needs_retry", "process"],
      [{ ok: false, error: err("NOT_FOUND", false) }, "failed", null],
      [{ ok: false, error: err("UNAUTHENTICATED", false) }, "failed", null],
    ] as const;
    for (const [result, phase, retry] of cases) {
      const mapped = phaseFromProcessResult(result as never);
      assert.equal(mapped.phase, phase, JSON.stringify(result));
      assert.equal(mapped.retry, retry, JSON.stringify(result));
    }
  });

  test("memory-pressure release (uploaded + SERVER_BUSY) → manual retry only; SERVER_CAPACITY → final", () => {
    const busy = phaseFromProcessResult({ ok: true, data: { documentId: "d", status: "uploaded", error: err("SERVER_BUSY", true) } });
    assert.deepEqual(busy, { phase: "needs_retry", error: err("SERVER_BUSY", true), retry: "process" });
    const capacity = phaseFromProcessResult({ ok: true, data: { documentId: "d", status: "failed", error: err("SERVER_CAPACITY", false) } });
    assert.deepEqual(capacity, { phase: "failed", error: err("SERVER_CAPACITY", false), retry: null });
    // Nothing schedules a retry by itself: an uploaded file is not something to poll.
    assert.equal(needsPolling([{ key: "k", name: "f.pdf", size: 1, phase: "needs_retry", uploadedBytes: 1, retry: "process" }] as never), false);
  });

  test("status page rows (refresh recovery)", () => {
    assert.deepEqual(phaseFromStatusView({ status: "pending_upload" }), { phase: "waiting", error: undefined, retry: "upload" });
    assert.deepEqual(phaseFromStatusView({ status: "uploaded" }), { phase: "needs_retry", error: undefined, retry: "process" });
    assert.equal(phaseFromStatusView({ status: "processing" }).phase, "processing");
    assert.equal(phaseFromStatusView({ status: "ready" }).phase, "ready");
    assert.equal(phaseFromStatusView({ status: "failed", error: err("ENCRYPTED_DOCUMENT", false) }).retry, null);
  });

  test("status sync only updates files the client believes are processing", () => {
    let run = uploadReducer(active(), { type: "upload_started", key: "a" });
    run = uploadReducer(run, { type: "upload_finished", key: "a" }); // a: processing
    run = uploadReducer(run, { type: "process_result", key: "b", result: { ok: true, data: { documentId: "d2", status: "ready" } } });
    run = uploadReducer(run, {
      type: "status_sync",
      documents: [
        { documentId: "d1", status: "ready" },
        { documentId: "d2", status: "failed" }, // b already settled locally: not overwritten
        { documentId: "d3", status: "ready" }, // c is still waiting locally: not overwritten
      ],
    });
    assert.deepEqual(run.files.map((f) => f.phase), ["ready", "ready", "waiting"]);
  });
});

describe("MIME hint and Storage upload responses", () => {
  test("browser MIME type is only forwarded when it is the accepted one", () => {
    assert.equal(mimeHint("pdf", "application/pdf"), "application/pdf");
    assert.equal(mimeHint("pdf", "application/x-pdf"), "");
    assert.equal(mimeHint("docx", ""), "");
    assert.equal(mimeHint("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  test("Storage answers → fixed outcomes", () => {
    assert.deepEqual(classifyUploadResponse(200, { Key: "x" }), { kind: "uploaded" });
    assert.deepEqual(classifyUploadResponse(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" }), { kind: "maybe_exists" });
    assert.deepEqual(classifyUploadResponse(400, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }), { kind: "maybe_exists" });
    assert.deepEqual(classifyUploadResponse(413, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" }), { kind: "failed", retryable: false, code: "TOO_LARGE" });
    assert.deepEqual(classifyUploadResponse(400, { statusCode: "415", error: "invalid_mime_type", message: "mime type text/plain is not supported" }), { kind: "failed", retryable: false, code: "TYPE_REJECTED" });
    assert.deepEqual(classifyUploadResponse(400, { statusCode: "400", error: "Unauthorized", message: "invalid JWT" }), { kind: "failed", retryable: true, code: "SESSION" });
    assert.deepEqual(classifyUploadResponse(500, null), { kind: "failed", retryable: true, code: "STORAGE" });
    assert.deepEqual(classifyUploadResponse(502, "<html>bad gateway</html>"), { kind: "failed", retryable: true, code: "STORAGE" });
  });
});
