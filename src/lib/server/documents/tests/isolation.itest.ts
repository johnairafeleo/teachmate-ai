/**
 * TASK 005.7 / 005.7.2: worker failures, memory protection and the time budget, through the
 * document service (HOSTED DEV project only). Fault-injection tests replace the worker via a
 * test-only option; the pathological-PDF and memory-bomb tests use the REAL worker with valid
 * %PDF- files, so signature checks and PDF.js are exercised.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, test } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { acquireExtractionSlot, extractionSlotsInUse, MEMORY_LIMITS, WORKER_LIMITS } from "../../../documents/isolated-extract.ts";
import { densePdfPage, flateBombPdf, LESSON, makeDocx, makePdf, para } from "../../../documents/tests/fixtures.ts";
import { processDocument, processDocumentAuthenticated, PROCESSING_BUDGET, type ServiceContext } from "../service.ts";

const DEV_REF = "gceuqyhuxpmnkmhhaivr";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
if (new URL(URL_).host !== `${DEV_REF}.supabase.co`) throw new Error("Refusing to run: not the teachmate-ai-dev project");

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_, SECRET, noPersist);
const FAULT = new URL("../../../documents/tests/fault-worker.ts", import.meta.url);
const createdUsers: string[] = [];

async function makeUser(fetchImpl?: typeof fetch): Promise<{ id: string; db: SupabaseClient }> {
  const email = `tm-e2e-${randomBytes(4).toString("hex")}@example.com`;
  const password = `E2e-${randomBytes(12).toString("base64url")}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser failed: ${error.code}`);
  createdUsers.push(data.user.id);
  const db = createClient(URL_, PUBLISHABLE, { ...noPersist, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}) });
  if ((await db.auth.signInWithPassword({ email, password })).error) throw new Error("sign-in failed");
  return { id: data.user.id, db };
}

/** Registers and uploads `body` (the fault worker reads its command from the first bytes). */
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
async function uploadedDoc(user: { id: string; db: SupabaseClient }, body: Uint8Array, kind: "pdf" | "docx" = "pdf") {
  const { data, error } = await user.db.rpc("create_materials_draft", {
    p_title: "Isolation test", p_grade_level: 3, p_subject: "science", p_language: "english", p_theme: "crayon-box", p_slide_count: 10,
    p_files: [{ name: `f.${kind}`, type: kind, size: body.length }],
  });
  if (error) throw new Error(`draft failed: ${error.code}`);
  const row = (data as { out_document_id: string; out_storage_path: string }[])[0];
  const type = kind === "pdf" ? "application/pdf" : DOCX_MIME;
  const up = await user.db.storage.from("source-materials").upload(row.out_storage_path, new Blob([new Uint8Array(body)], { type }), { upsert: false });
  assert.equal(up.error, null);
  return { id: row.out_document_id, path: row.out_storage_path };
}
const ctx = (user: { id: string; db: SupabaseClient }, options: ServiceContext["options"] = {}): ServiceContext => ({ userId: user.id, db: user.db, admin, log: () => {}, options: { retryDelayMs: 20, ...options } });
const rowOf = async (id: string) => (await admin.from("source_documents").select("processing_status, processing_error").eq("id", id).single()).data;
const objectExists = async (path: string) => (await admin.storage.from("source-materials").exists(path)).data === true;
const extractCount = async (id: string) => (await admin.from("document_extracts").select("source_document_id").eq("source_document_id", id)).data?.length ?? -1;
const MiB = 1024 * 1024;

after(async () => {
  for (const userId of createdUsers) {
    const { data: folders } = await admin.storage.from("source-materials").list(userId);
    for (const folder of folders ?? []) {
      const { data: objects } = await admin.storage.from("source-materials").list(`${userId}/${folder.name}`);
      const paths = (objects ?? []).map((o) => `${userId}/${folder.name}/${o.name}`);
      if (paths.length) await admin.storage.from("source-materials").remove(paths);
    }
    await admin.auth.admin.deleteUser(userId);
  }
  const left = (await Promise.all(createdUsers.map((id) => admin.auth.admin.getUserById(id)))).filter((r) => r.data?.user).length;
  console.log(`  cleanup: ${createdUsers.length} test users; users left ${left}`);
  assert.equal(left, 0);
  assert.equal(extractionSlotsInUse(), 0);
});

describe("worker failures through the document service", () => {
  test("hung worker: hard timeout → recorded as failed TIMEOUT (never left processing), object deleted, slot released", async () => {
    const U = await makeUser();
    // Storage only checks the declared type, so a body starting with HANG can be stored as a PDF.
    const doc = await uploadedDoc(U, new TextEncoder().encode("HANG".padEnd(200, " ")));
    const started = Date.now();
    const result = await processDocument(ctx(U, { workerUrl: FAULT, extractionDeadlineMs: 200 }), doc.id);
    assert.ok(result.ok && result.data.status === "failed" && result.data.error?.code === "TIMEOUT", JSON.stringify(result));
    assert.ok(Date.now() - started < 10_000, "bounded");
    assert.deepEqual(await rowOf(doc.id), { processing_status: "failed", processing_error: "TIMEOUT" });
    assert.equal(await objectExists(doc.path), false);
    assert.equal(extractionSlotsInUse(), 0);
    const again = await processDocument(ctx(U), doc.id);
    assert.ok(again.ok && again.data.status === "failed", "retry is safe and idempotent");
  });

  test("crashing worker → recorded as failed INTERNAL_ERROR", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, new TextEncoder().encode("CRASH".padEnd(200, " ")));
    const result = await processDocument(ctx(U, { workerUrl: FAULT }), doc.id);
    assert.ok(result.ok && result.data.status === "failed" && result.data.error?.code === "INTERNAL_ERROR", JSON.stringify(result));
    assert.equal((await rowOf(doc.id))?.processing_status, "failed");
  });

  test("invalid worker reply → failed INTERNAL_ERROR; never marked ready", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, new TextEncoder().encode("INVALID:2".padEnd(200, " "))); // 100,001-char text
    const result = await processDocument(ctx(U, { workerUrl: FAULT }), doc.id);
    assert.ok(result.ok && result.data.status === "failed", JSON.stringify(result));
    assert.equal((await admin.from("document_extracts").select("source_document_id").eq("source_document_id", doc.id)).data?.length, 0);
  });

  test("saturated instance → SERVER_BUSY (retryable), document NOT claimed; later retry → ready", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, makePdf([["Busy", LESSON]]));
    const held = await Promise.all(Array.from({ length: WORKER_LIMITS.maxConcurrentWorkers }, () => acquireExtractionSlot(0)));
    let busy;
    try {
      busy = await processDocument(ctx(U, { slotWaitMs: 100 }), doc.id);
    } finally {
      held.forEach((slot) => slot?.release());
    }
    assert.ok(busy.ok && busy.data.status === "uploaded" && busy.data.error?.code === "SERVER_BUSY" && busy.data.error.retryable, JSON.stringify(busy));
    assert.equal((await rowOf(doc.id))?.processing_status, "uploaded", "not claimed while busy");
    const retry = await processDocument(ctx(U), doc.id);
    assert.ok(retry.ok && retry.data.status === "ready", JSON.stringify(retry));
  });
});

describe("memory protection through the document service (real worker, valid PDFs)", () => {
  test("valid pathological PDF (dense 8 MiB page) through the real worker: TIMEOUT recorded, object deleted, slot released", async () => {
    const U = await makeUser();
    const dense = densePdfPage(8);
    assert.equal(new TextDecoder().decode(dense.slice(0, 5)), "%PDF-", "a real PDF signature");
    const doc = await uploadedDoc(U, dense);
    const started = Date.now();
    const result = await processDocument(ctx(U, { extractionDeadlineMs: 200 }), doc.id);
    const elapsed = Date.now() - started;
    assert.ok(result.ok && result.data.status === "failed" && result.data.error?.code === "TIMEOUT", JSON.stringify(result));
    assert.deepEqual(await rowOf(doc.id), { processing_status: "failed", processing_error: "TIMEOUT" });
    assert.equal(await objectExists(doc.path), false);
    assert.equal(await extractCount(doc.id), 0);
    assert.equal(extractionSlotsInUse(), 0);
    console.log(`  dense 8 MiB PDF via service (200 ms deadline): failed TIMEOUT in ${elapsed} ms (download + extraction + recording)`);
  });

  test("compressed PDF memory bomb (~1 MiB file → 1 GiB decoded): LIMITS_EXCEEDED recorded, object deleted; retry stays failed", async () => {
    const U = await makeUser();
    const bomb = flateBombPdf(1024);
    const doc = await uploadedDoc(U, bomb);
    const start = process.memoryUsage.rss();
    let peak = start;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 5);
    const result = await processDocument(ctx(U), doc.id);
    clearInterval(sampler);
    assert.ok(result.ok && result.data.status === "failed" && result.data.error?.code === "LIMITS_EXCEEDED", JSON.stringify(result));
    assert.equal(result.ok && result.data.error?.retryable, false);
    assert.deepEqual(await rowOf(doc.id), { processing_status: "failed", processing_error: "LIMITS_EXCEEDED" });
    assert.equal(await objectExists(doc.path), false);
    assert.equal(await extractCount(doc.id), 0);
    assert.equal(extractionSlotsInUse(), 0);
    const growth = Math.round((peak - start) / MiB);
    assert.ok(growth < 512 + 384, `peak growth ${growth} MiB`);
    const again = await processDocument(ctx(U), doc.id);
    assert.ok(again.ok && again.data.status === "failed" && again.data.error?.code === "LIMITS_EXCEEDED", "retry is idempotent");
    console.log(`  1 GiB-decoding PDF via service: failed LIMITS_EXCEEDED; process rss ${Math.round(start / MiB)} MiB → peak +${growth} MiB`);
  });

  test("high baseline memory → SERVER_BUSY (retryable), NOT claimed, no worker started; retry later → ready", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, makePdf([["Memory", LESSON]]));
    const high = { ...MEMORY_LIMITS, readRss: () => MEMORY_LIMITS.admissionRssBytes + 64 * MiB };
    // A worker URL that cannot load proves no worker was started (that would record INTERNAL_ERROR).
    const busy = await processDocument(ctx(U, { memory: high, workerUrl: new URL("./does-not-exist.ts", import.meta.url) }), doc.id);
    assert.ok(busy.ok && busy.data.status === "uploaded" && busy.data.error?.code === "SERVER_BUSY" && busy.data.error.retryable, JSON.stringify(busy));
    assert.deepEqual(await rowOf(doc.id), { processing_status: "uploaded", processing_error: null });
    assert.equal(extractionSlotsInUse(), 0);
    const retry = await processDocument(ctx(U), doc.id);
    assert.ok(retry.ok && retry.data.status === "ready", JSON.stringify(retry));
  });

  test("ordinary PDF and DOCX still succeed end to end", async () => {
    const U = await makeUser();
    const pdf = await uploadedDoc(U, makePdf([["Grade 3 Science", LESSON], ["Parts of a plant."]]));
    const docx = await uploadedDoc(U, makeDocx({ body: para("Lesson") + para(LESSON) }), "docx");
    for (const doc of [pdf, docx]) {
      const result = await processDocument(ctx(U), doc.id);
      assert.ok(result.ok && result.data.status === "ready" && (result.data.extract?.charCount ?? 0) > 50, JSON.stringify(result));
      assert.equal(await objectExists(doc.path), true, "ready documents keep their object");
    }
  });
});

describe("total processing budget", () => {
  test("not enough time left to extract → SERVER_BUSY without claiming (download skipped: STORAGE_UNAVAILABLE)", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, makePdf([["Budget", LESSON]]));
    // Budget below finalize reserve + min extraction + grace: the download is not even started.
    const tooShort = PROCESSING_BUDGET.finalizeReserveMs + PROCESSING_BUDGET.minExtractionMs;
    const result = await processDocument(ctx(U, { processingBudgetMs: tooShort }), doc.id);
    assert.ok(result.ok && result.data.status === "uploaded" && result.data.error?.retryable, JSON.stringify(result));
    assert.equal((await rowOf(doc.id))?.processing_status, "uploaded", "not claimed");
    const retry = await processDocument(ctx(U), doc.id);
    assert.ok(retry.ok && retry.data.status === "ready", JSON.stringify(retry));
  });

  test("the extraction deadline is capped by the budget: a hung worker is killed in time to record the failure", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, new TextEncoder().encode("HANG".padEnd(200, " ")));
    const budgetMs = 20_000; // leaves ~8.5 s for extraction after the 10 s finalize reserve and 1.5 s grace
    const started = Date.now();
    const result = await processDocument(ctx(U, { workerUrl: FAULT, processingBudgetMs: budgetMs }), doc.id);
    const elapsed = Date.now() - started;
    assert.ok(result.ok && result.data.status === "failed" && result.data.error?.code === "TIMEOUT", JSON.stringify(result));
    assert.ok(elapsed < budgetMs, `finished in ${elapsed} ms (budget ${budgetMs} ms)`);
    assert.ok(elapsed < budgetMs - PROCESSING_BUDGET.finalizeReserveMs + 3_000, `extraction stopped before the finalize reserve (${elapsed} ms)`);
    assert.equal(await objectExists(doc.path), false);
    console.log(`  hung worker, 20 s budget: failed TIMEOUT after ${elapsed} ms (default deadline would be 20 s + 1.5 s)`);
  });

  test("a stalled Storage download is really aborted (signal reaches fetch) and stays retryable", async () => {
    let downloads = 0;
    let aborted = 0;
    const stallingFetch: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("/storage/v1/object/source-materials/") || (init?.method ?? "GET") !== "GET") return fetch(input, init);
      downloads += 1;
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return; // would hang forever: the assertion below catches it
        signal.addEventListener("abort", () => {
          aborted += 1;
          reject(signal.reason);
        }, { once: true });
      });
    };
    const U = await makeUser(stallingFetch);
    const doc = await uploadedDoc(U, makePdf([["Stall", LESSON]]));
    // 17 s budget: 2.5 s before the pre-extraction reserve (14.5 s) → each attempt aborts at that point.
    const started = Date.now();
    const result = await processDocument(ctx(U, { processingBudgetMs: 17_000, downloadAttempts: 3 }), doc.id);
    const elapsed = Date.now() - started;
    assert.ok(result.ok && result.data.status === "uploaded" && result.data.error?.code === "STORAGE_UNAVAILABLE", JSON.stringify(result));
    assert.ok(downloads >= 1 && aborted === downloads, `downloads ${downloads}, aborted ${aborted}`);
    assert.ok(elapsed < 6_000, `returned after ${elapsed} ms`);
    assert.equal((await rowOf(doc.id))?.processing_status, "uploaded", "never claimed");
    console.log(`  stalled download: ${downloads} attempt(s), all aborted; STORAGE_UNAVAILABLE after ${elapsed} ms`);
  });
});

describe("TASK 005.7.3: authentication-inclusive deadline and post-claim admission", () => {
  test("time spent authenticating consumes the same processing budget", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, makePdf([["Auth budget", LESSON]]));
    const budgetMs = 18_000; // 3.5 s before the pre-extraction reserve (finalize 10 + min extraction 3 + grace 1.5)
    // Slow authentication (5 s): only ~13 s left afterwards, below the 14.5 s reserve, so the
    // download is never started and nothing is claimed.
    let authEndedAfterMs = 0;
    const started = Date.now();
    const slow = await processDocumentAuthenticated(async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      authEndedAfterMs = Date.now() - started;
      return ctx(U);
    }, doc.id, budgetMs);
    assert.ok(authEndedAfterMs >= 5_000);
    assert.ok(slow.ok && slow.data.status === "uploaded" && slow.data.error?.code === "STORAGE_UNAVAILABLE" && slow.data.error.retryable, JSON.stringify(slow));
    assert.equal((await rowOf(doc.id))?.processing_status, "uploaded", "not claimed");
    // Same budget, instant authentication → processed normally.
    const fast = await processDocumentAuthenticated(async () => ctx(U), doc.id, budgetMs);
    assert.ok(fast.ok && fast.data.status === "ready", JSON.stringify(fast));
    console.log(`  18 s budget: 5 s auth → not started (STORAGE_UNAVAILABLE, retryable); instant auth → ready`);
  });

  test("memory rises between admission and worker start (after the claim): extraction still runs, document NOT failed", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, makePdf([["Race", LESSON]]));
    // The service's admission check (first read) sees 100 MiB; every later read sees 900 MiB:
    // above admission (768) but below the absolute ceiling (1,280). Before TASK 005.7.3 the
    // worker's own admission check refused here → claimed document failed with TIMEOUT.
    let reads = 0;
    const memory = { ...MEMORY_LIMITS, readRss: () => (reads++ === 0 ? 100 * MiB : 900 * MiB) };
    const result = await processDocument(ctx(U, { memory }), doc.id);
    assert.ok(reads >= 2, "admission and watchdog both read RSS");
    assert.ok(result.ok && result.data.status === "ready", JSON.stringify(result));
    assert.deepEqual(await rowOf(doc.id), { processing_status: "ready", processing_error: null });
    assert.equal(extractionSlotsInUse(), 0);
  });
});

describe("TASK 005.7.6: retryable memory-pressure releases (requires migration 0800)", () => {
  /** Fake process RSS: passes admission, then exceeds the absolute ceiling after 150 ms. */
  const pressure = (workerBytes: () => Promise<number> = async () => 20 * MiB) => {
    const t0 = Date.now();
    return { ...MEMORY_LIMITS, readRss: () => (Date.now() - t0 >= 150 ? 1400 * MiB : 300 * MiB), readWorkerBytes: workerBytes };
  };
  const releaseState = async (id: string) =>
    (await admin.from("source_documents").select("processing_status, processing_error, processing_attempt, memory_release_count").eq("id", id).single()).data;
  const quota = async (U: { db: SupabaseClient }) => JSON.stringify((await U.db.rpc("my_upload_quota")).data);

  test("shared pressure → uploaded + SERVER_BUSY, object kept, quota unchanged; manual retry → ready", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, new TextEncoder().encode("SLOW:3000".padEnd(200, " ")));
    const before = await quota(U);
    const released = await processDocument(ctx(U, { workerUrl: FAULT, memory: pressure() }), doc.id);
    assert.ok(released.ok && released.data.status === "uploaded" && released.data.error?.code === "SERVER_BUSY" && released.data.error.retryable, JSON.stringify(released));
    assert.deepEqual(await releaseState(doc.id), { processing_status: "uploaded", processing_error: null, processing_attempt: null, memory_release_count: 1 });
    assert.equal(await objectExists(doc.path), true);
    assert.equal(await quota(U), before, "quota unchanged");
    const retry = await processDocument(ctx(U, { workerUrl: FAULT }), doc.id);
    assert.ok(retry.ok && retry.data.status === "ready", JSON.stringify(retry));
  });

  test("document-caused (worker ≥ 256 MiB) → permanent LIMITS_EXCEEDED; two releases then SERVER_CAPACITY", async () => {
    const U = await makeUser();
    const own = await uploadedDoc(U, new TextEncoder().encode("SLOW:3000".padEnd(200, " ")));
    const blamed = await processDocument(ctx(U, { workerUrl: FAULT, memory: pressure(async () => 300 * MiB) }), own.id);
    assert.ok(blamed.ok && blamed.data.status === "failed" && blamed.data.error?.code === "LIMITS_EXCEEDED", JSON.stringify(blamed));
    assert.equal(await objectExists(own.path), false);

    const capped = await uploadedDoc(U, new TextEncoder().encode("SLOW:3000".padEnd(200, " ")));
    for (let i = 1; i <= 2; i++) {
      const r = await processDocument(ctx(U, { workerUrl: FAULT, memory: pressure() }), capped.id);
      assert.ok(r.ok && r.data.status === "uploaded" && r.data.error?.code === "SERVER_BUSY", `release ${i}: ${JSON.stringify(r)}`);
    }
    const third = await processDocument(ctx(U, { workerUrl: FAULT, memory: pressure() }), capped.id);
    assert.ok(third.ok && third.data.status === "failed" && third.data.error?.code === "SERVER_CAPACITY" && !third.data.error.retryable, JSON.stringify(third));
    assert.equal((await releaseState(capped.id))?.memory_release_count, 2);
    assert.equal(await objectExists(capped.path), false, "deleted only after the confirmed failure");
  });

  test("API roles cannot call the release RPC or reset the counter", async () => {
    const U = await makeUser();
    const doc = await uploadedDoc(U, makePdf([["Grants", LESSON]]));
    const call = await U.db.rpc("svc_release_document_processing", { p_user_id: U.id, p_document_id: doc.id, p_attempt: doc.id });
    assert.ok(call.error, "teacher session refused");
    const update = await U.db.from("source_documents").update({ memory_release_count: 0 }).eq("id", doc.id).select();
    assert.ok(update.error || (update.data ?? []).length === 0, "no update grant");
  });
});
