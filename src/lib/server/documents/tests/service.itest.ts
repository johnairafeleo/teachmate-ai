/**
 * Integration tests for the document service against the HOSTED DEVELOPMENT project only.
 *   npm run test:integration
 * Disposable confirmed users (admin API, no email sent), synthetic files, full cleanup.
 * Never prints keys, tokens or document text.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { contentTypesXml, LESSON, makeDocx, makePdf, makeZip, para, TYPES } from "../../../documents/tests/fixtures.ts";
import { createMaterialsDraft, getPresentationDocuments, processDocument, SOURCE_BUCKET, type ServiceContext, type UploadTarget } from "../service.ts";

const DEV_REF = "gceuqyhuxpmnkmhhaivr";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
if (new URL(URL_).host !== `${DEV_REF}.supabase.co`) throw new Error("Refusing to run: not the teachmate-ai-dev project");

const MiB = 1024 * 1024;
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const admin = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(URL_, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });

type TestUser = { id: string; email: string; password: string; db: SupabaseClient };
const createdUsers: string[] = [];
const logs: { event: string; fields: Record<string, unknown> }[] = [];

async function signedInClient(email: string, password: string, fetchImpl?: typeof fetch): Promise<SupabaseClient> {
  const client = createClient(URL_, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.code}`);
  return client;
}

async function makeUser(): Promise<TestUser> {
  const email = `tm-e2e-${randomBytes(4).toString("hex")}@example.com`;
  const password = `E2e-${randomBytes(12).toString("base64url")}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser failed: ${error.code}`);
  createdUsers.push(data.user.id);
  return { id: data.user.id, email, password, db: await signedInClient(email, password) };
}

function ctxFor(user: { id: string }, db: SupabaseClient, adminClient: SupabaseClient = admin): ServiceContext {
  return {
    userId: user.id,
    db,
    admin: adminClient,
    log: (event, fields) => logs.push({ event, fields }),
    options: { retryDelayMs: 20, downloadAttempts: 2 },
  };
}
const ctx = (user: TestUser) => ctxFor(user, user.db);

const draftInput = (files: { name: string; size: number; mimeType?: string }[], overrides: Record<string, unknown> = {}) => ({
  title: "Integration test lesson",
  grade: "3",
  subject: "science",
  language: "english",
  theme: "crayon-box",
  slideCount: "10",
  files,
  ...overrides,
});

/**
 * Bounded retry for transient network failures between this machine and Supabase (seen as
 * ECONNRESET). Mirrors what the UI will do with `retryable` results; deliberate failure-injection
 * tests never use it.
 */
async function retrying<T>(run: () => PromiseLike<T>, transient: (value: T) => boolean, attempts = 4): Promise<T> {
  let value = await run();
  for (let attempt = 1; attempt < attempts && transient(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    value = await run();
  }
  return value;
}

async function draft(user: TestUser, files: { name: string; size: number; mimeType?: string }[]) {
  const result = await retrying(
    () => createMaterialsDraft(ctx(user), draftInput(files)),
    (r) => !r.ok && r.error.code === "INTERNAL_ERROR",
  );
  assert.ok(result.ok, `draft failed: ${JSON.stringify(!result.ok && result.error)}`);
  return result.data;
}

async function upload(user: TestUser, target: UploadTarget, bytes: Uint8Array, contentType = target.contentType) {
  const body = new Blob([new Uint8Array(bytes)], { type: contentType });
  const { error } = await retrying(
    () => user.db.storage.from(SOURCE_BUCKET).upload(target.storagePath, body, { upsert: false }),
    (r) => r.error !== null && !(r.error as { statusCode?: string }).statusCode, // network failures only
  );
  // A retry after a lost response is rejected (no overwrite); the object existing means it landed.
  assert.ok(error === null || (await objectExists(target.storagePath)), `upload failed: ${error?.message}`);
}

/** processDocument with the UI's retry behaviour for transient (retryable) outcomes. */
async function processSettled(user: TestUser, documentId: string) {
  return retrying(
    () => processDocument(ctx(user), documentId),
    (r) => (r.ok ? r.data.error?.retryable === true && r.data.error.code !== "UPLOAD_INCOMPLETE" : r.error.retryable),
  );
}

const hasError = <T extends { error: unknown }>(r: T) => r.error !== null;

async function objectExists(path: string): Promise<boolean> {
  const dir = path.split("/").slice(0, -1).join("/");
  const name = path.split("/").pop();
  const { data, error } = await retrying(() => admin.storage.from(SOURCE_BUCKET).list(dir, { search: name }), hasError);
  assert.equal(error, null, `storage list failed: ${error?.message}`);
  return (data ?? []).some((object) => object.name === name);
}

async function row(documentId: string) {
  const { data, error } = await retrying(
    () => admin.from("source_documents").select("processing_status, processing_error, file_size").eq("id", documentId).single(),
    hasError,
  );
  assert.equal(error, null, `row read failed: ${error?.code} ${error?.message}`);
  return data as { processing_status: string; processing_error: string | null; file_size: number };
}

async function extractRows(documentId: string) {
  const { data, error } = await retrying(
    () => admin.from("document_extracts").select("char_count, page_count, is_truncated, created_at, extractor_version").eq("source_document_id", documentId),
    hasError,
  );
  assert.equal(error, null, `extract read failed: ${error?.code} ${error?.message}`);
  return data ?? [];
}

async function quota(user: TestUser) {
  const { data, error } = await retrying(() => user.db.rpc("my_upload_quota"), hasError);
  assert.equal(error, null, `my_upload_quota failed: ${error?.code} ${error?.message}`);
  return (data as { attempts_today: number; bytes_today: number; stored_bytes: number }[])[0];
}

const pdfBytes = () => makePdf([["Grade 3 Science", LESSON], ["Parts of a plant: roots, stem and leaves."]]);
const docxBytes = () => makeDocx({ body: para("Lesson: The water cycle") + para(LESSON) });
const file = (name: string, size: number, mimeType?: string) => ({ name, size, ...(mimeType !== undefined ? { mimeType } : {}) });

/** fetch wrapper that fails (or truncates) only Supabase Storage object requests. */
function storageFetch(mode: "fail-download" | "truncate-download" | "fail-delete"): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const isObject = url.includes("/storage/v1/object/");
    if (isObject && mode === "fail-download" && method === "GET") throw new TypeError("fetch failed (simulated)");
    if (isObject && mode === "fail-delete" && method === "DELETE") throw new TypeError("fetch failed (simulated)");
    const response = await fetch(input, init);
    if (isObject && mode === "truncate-download" && method === "GET" && response.ok) {
      const body = new Uint8Array(await response.arrayBuffer());
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(body.slice(0, Math.max(0, body.length - 10)), { status: response.status, headers });
    }
    return response;
  };
}

let A: TestUser;
let B: TestUser;

before(async () => {
  A = await makeUser();
  B = await makeUser();
});

after(async () => {
  // Cleanup: Storage objects first, then users (cascades presentations, documents, extracts, ledger).
  for (const userId of createdUsers) {
    const { data: folders } = await retrying(() => admin.storage.from(SOURCE_BUCKET).list(userId), hasError, 6);
    for (const folder of folders ?? []) {
      const { data: objects } = await retrying(() => admin.storage.from(SOURCE_BUCKET).list(`${userId}/${folder.name}`), hasError, 6);
      const paths = (objects ?? []).map((object) => `${userId}/${folder.name}/${object.name}`);
      if (paths.length) await retrying(() => admin.storage.from(SOURCE_BUCKET).remove(paths), hasError, 6);
    }
  }
  for (const userId of createdUsers) {
    // "not found" means it is already gone (e.g. the revoked-identity test deleted it).
    await retrying(() => admin.auth.admin.deleteUser(userId), (r) => r.error !== null && r.error.status !== 404, 6);
  }
  const leftovers = {
    presentations: (await admin.from("presentations").select("id", { count: "exact", head: true }).in("user_id", createdUsers)).count,
    documents: (await admin.from("source_documents").select("id", { count: "exact", head: true }).in("user_id", createdUsers)).count,
    ledger: (await admin.from("upload_quota_usage").select("user_id", { count: "exact", head: true }).in("user_id", createdUsers)).count,
    objects: (await Promise.all(createdUsers.map((id) => admin.storage.from(SOURCE_BUCKET).list(id)))).reduce((n, r) => n + (r.data?.length ?? 0), 0),
    users: (await Promise.all(createdUsers.map((id) => admin.auth.admin.getUserById(id)))).filter((r) => r.data?.user).length,
  };
  console.log(`  cleanup: ${createdUsers.length} test users; leftovers ${JSON.stringify(leftovers)}`);
  assert.deepEqual(leftovers, { presentations: 0, documents: 0, ledger: 0, objects: 0, users: 0 });
  // Logs carry ids and fixed codes only — never document text.
  assert.doesNotMatch(JSON.stringify(logs), /Photosynthesis|water cycle|Grade 3 Science/);
});

describe("draft creation", () => {
  test("1 and 3 files: atomic draft, presentation id, safe upload targets", async () => {
    const one = await draft(A, [file("Plant lesson.pdf", 1000, PDF_MIME)]);
    assert.match(one.presentationId, /^[0-9a-f-]{36}$/);
    assert.equal(one.uploads.length, 1);
    const target = one.uploads[0];
    assert.equal(target.storagePath, `${A.id}/${one.presentationId}/${target.documentId}.pdf`);
    assert.equal(target.contentType, PDF_MIME);
    assert.deepEqual(Object.keys(one).sort(), ["bucket", "presentationId", "uploads"]);
    assert.deepEqual(Object.keys(target).sort(), ["contentType", "declaredSize", "documentId", "fileName", "fileType", "maxBytes", "storagePath"]);

    const three = await draft(A, [file("a.pdf", 10), file("b.docx", 20, ""), file("..\\..\\c.DOCX", 30, DOCX_MIME)]);
    assert.deepEqual(three.uploads.map((u) => u.fileName), ["a.pdf", "b.docx", "c.DOCX"]);
    assert.deepEqual(three.uploads.map((u) => u.contentType), [PDF_MIME, DOCX_MIME, DOCX_MIME]);
  });

  test("invalid manifests are rejected before touching the database", async () => {
    const before = (await quota(A)).attempts_today;
    const cases: [string, unknown][] = [
      ["no files", draftInput([])],
      ["four files", draftInput([file("a.pdf", 1), file("b.pdf", 1), file("c.pdf", 1), file("d.pdf", 1)])],
      ["empty file", draftInput([file("a.pdf", 0)])],
      ["over 10 MiB", draftInput([file("a.pdf", 10 * MiB + 1)])],
      ["unsupported extension", draftInput([file("notes.txt", 10)])],
      ["double extension", draftInput([file("notes.pdf.exe", 10)])],
      ["MIME/extension mismatch", draftInput([file("a.pdf", 10, DOCX_MIME)])],
      ["foreign MIME", draftInput([file("a.docx", 10, "text/html")])],
      ["control characters in name", draftInput([file("a\u0007.pdf", 10)])],
      ["blank title", draftInput([file("a.pdf", 10)], { title: "   " })],
      ["grade 7", draftInput([file("a.pdf", 10)], { grade: "7" })],
      ["unknown subject", draftInput([file("a.pdf", 10)], { subject: "hacking" })],
      ["slide count 7", draftInput([file("a.pdf", 10)], { slideCount: 7 })],
      ["not an object", "garbage"],
    ];
    for (const [label, input] of cases) {
      const result = await createMaterialsDraft(ctx(A), input);
      assert.ok(!result.ok && result.error.code === "INVALID_INPUT", `${label}: ${JSON.stringify(result)}`);
    }
    assert.equal((await quota(A)).attempts_today, before, "no quota charged");
  });

  test("no session: draft refused, documents invisible (no admin call reaches another user's row)", async () => {
    const result = await createMaterialsDraft(ctxFor(A, anon), draftInput([file("a.pdf", 10)]));
    assert.ok(!result.ok && result.error.code === "UNAUTHENTICATED", JSON.stringify(result));
    const target = (await draft(A, [file("victim.pdf", 100)])).uploads[0];
    const processed = await processDocument(ctxFor(A, anon), target.documentId);
    assert.ok(!processed.ok && processed.error.code === "UNAUTHENTICATED", JSON.stringify(processed));
    assert.equal((await row(target.documentId)).processing_status, "pending_upload");
    const status = await getPresentationDocuments(ctxFor(A, anon), (await draft(A, [file("x.pdf", 10)])).presentationId);
    assert.ok(!status.ok && status.error.code === "UNAUTHENTICATED", JSON.stringify(status));
  });

  test("revoked identity: a deleted user's still-valid JWT fails the verified check", async () => {
    const X = await makeUser();
    await admin.auth.admin.deleteUser(X.id);
    const { data, error } = await X.db.auth.getUser(); // what requireVerifiedUser() relies on
    assert.ok(error || !data.user, "getUser must reject a deleted user");
  });
});

describe("processing", () => {
  test("PDF: declared size differs from actual → verified actual size, extracted, ready", async () => {
    const bytes = pdfBytes();
    const before = await quota(A);
    const target = (await draft(A, [file("lesson.pdf", 999, PDF_MIME)])).uploads[0];
    await upload(A, target, bytes);
    const result = await processSettled(A, target.documentId);
    assert.ok(result.ok && result.data.status === "ready", JSON.stringify(result));
    assert.equal(result.data.extract?.pageCount, 2);
    const stored = await row(target.documentId);
    assert.equal(Number(stored.file_size), bytes.length, "file_size is the actual stored size");
    const extracts = await extractRows(target.documentId);
    assert.equal(extracts.length, 1);
    assert.match(String(extracts[0].extractor_version), /^tm-pdf-1\+pdfjs-6\.4\.299$/);
    const after = await quota(A);
    assert.equal(after.attempts_today, before.attempts_today + 1, "one attempt for one registration");
    assert.equal(Number(after.bytes_today) - Number(before.bytes_today), Math.max(bytes.length, 999), "declared size + positive difference only");
    assert.ok(await objectExists(target.storagePath), "successful object kept");
  });

  test("DOCX: extracted, ready, page_count null", async () => {
    const bytes = docxBytes();
    const target = (await draft(A, [file("lesson.docx", bytes.length, "")])).uploads[0];
    await upload(A, target, bytes);
    const result = await processSettled(A, target.documentId);
    assert.ok(result.ok && result.data.status === "ready", JSON.stringify(result));
    assert.equal(result.data.extract?.pageCount, null);
    assert.ok(await objectExists(target.storagePath));
  });

  test("malformed, encrypted and unsupported files fail with fixed codes and are deleted", async () => {
    const xlsx = makeZip([
      { name: "[Content_Types].xml", data: contentTypesXml(TYPES.xlsx, "/xl/workbook.xml") },
      { name: "xl/workbook.xml", data: "<workbook/>" },
    ]);
    const garbage = new TextEncoder().encode("%PDF-1.7\n" + "garbage ".repeat(200));
    const encrypted = makePdf([[LESSON]], { encrypt: true });
    const pdf = pdfBytes();
    const d1 = await draft(A, [file("broken.pdf", garbage.length), file("locked.pdf", encrypted.length), file("sheet.docx", xlsx.length)]);
    const d2 = await draft(A, [file("disguised.docx", pdf.length), file("mislabeled.pdf", pdf.length)]);
    const cases: [UploadTarget, Uint8Array, string, string][] = [
      [d1.uploads[0], garbage, PDF_MIME, "MALFORMED_DOCUMENT"],
      [d1.uploads[1], encrypted, PDF_MIME, "ENCRYPTED_DOCUMENT"],
      [d1.uploads[2], xlsx, DOCX_MIME, "NOT_A_WORD_DOCUMENT"],
      [d2.uploads[0], pdf, DOCX_MIME, "TYPE_MISMATCH"], // PDF bytes registered as .docx
      [d2.uploads[1], pdf, DOCX_MIME, "TYPE_MISMATCH"], // stored MIME contradicts the registered type
    ];
    for (const [target, bytes, mime, expected] of cases) {
      await upload(A, target, bytes, mime);
      const result = await processSettled(A, target.documentId);
      assert.ok(result.ok && result.data.status === "failed", `${expected}: ${JSON.stringify(result)}`);
      assert.equal(result.data.error?.code, expected);
      assert.equal(result.data.error?.retryable, false);
      assert.equal(result.data.cleanupPending, undefined);
      assert.equal((await row(target.documentId)).processing_error, expected, "only the fixed code is stored");
      assert.equal(await objectExists(target.storagePath), false, "failed object deleted");
      assert.equal((await extractRows(target.documentId)).length, 0);
    }
  });

  test("missing upload / unknown id / invalid id", async () => {
    const target = (await draft(A, [file("never-uploaded.pdf", 500)])).uploads[0];
    const pending = await processDocument(ctx(A), target.documentId);
    assert.ok(pending.ok && pending.data.status === "pending_upload" && pending.data.error?.code === "UPLOAD_INCOMPLETE" && pending.data.error.retryable);
    assert.equal((await row(target.documentId)).processing_status, "pending_upload", "never marked ready or failed");
    const unknown = await processDocument(ctx(A), randomUUID());
    assert.ok(!unknown.ok && unknown.error.code === "NOT_FOUND");
    for (const bad of ["abc", "", 42, null, { id: target.documentId }, `${target.documentId}' or 1=1`]) {
      const result = await processDocument(ctx(A), bad);
      assert.ok(!result.ok && result.error.code === "INVALID_INPUT", JSON.stringify(bad));
    }
  });

  test("cross-user: B cannot process or read A's documents", async () => {
    const d = await draft(A, [file("private.pdf", pdfBytes().length)]);
    await upload(A, d.uploads[0], pdfBytes());
    const processed = await processDocument(ctx(B), d.uploads[0].documentId);
    assert.ok(!processed.ok && processed.error.code === "NOT_FOUND");
    assert.equal((await row(d.uploads[0].documentId)).processing_status, "pending_upload", "untouched");
    // Even with A's id in the context, B's session sees nothing (RLS), so no admin call happens.
    const forged = await processDocument(ctxFor(A, B.db), d.uploads[0].documentId);
    assert.ok(!forged.ok && forged.error.code === "NOT_FOUND");
    assert.equal((await row(d.uploads[0].documentId)).processing_status, "pending_upload", "untouched");
    const status = await getPresentationDocuments(ctx(B), d.presentationId);
    assert.ok(!status.ok && status.error.code === "NOT_FOUND");
    const own = await getPresentationDocuments(ctx(A), d.presentationId);
    assert.ok(own.ok && own.data.documents.length === 1 && own.data.quota !== null);
  });

  test("duplicate requests: idempotent, no extra quota, object kept", async () => {
    const bytes = pdfBytes();
    const target = (await draft(A, [file("twice.pdf", bytes.length)])).uploads[0];
    await upload(A, target, bytes);
    const first = await processSettled(A, target.documentId);
    assert.ok(first.ok && first.data.status === "ready");
    const extractBefore = await extractRows(target.documentId);
    const quotaBefore = await quota(A);
    for (let i = 0; i < 3; i++) {
      const again = await processSettled(A, target.documentId);
      assert.ok(again.ok && again.data.status === "ready");
    }
    assert.deepEqual(await extractRows(target.documentId), extractBefore, "extract not rewritten");
    assert.deepEqual(await quota(A), quotaBefore, "no double charge");
    assert.ok(await objectExists(target.storagePath));
  });

  test("concurrent requests: exactly one extraction, final state ready", async () => {
    const bytes = docxBytes();
    const target = (await draft(A, [file("race.docx", bytes.length)])).uploads[0];
    await upload(A, target, bytes);
    const quotaBefore = await quota(A);
    const results = await Promise.all(Array.from({ length: 5 }, () => processDocument(ctx(A), target.documentId)));
    const statuses = results.map((r) => (r.ok ? r.data.status : r.error.code));
    assert.ok(statuses.every((s) => s === "ready" || s === "processing"), statuses.join(" "));
    assert.ok(statuses.includes("ready"));
    assert.equal((await row(target.documentId)).processing_status, "ready");
    assert.equal((await extractRows(target.documentId)).length, 1);
    assert.equal((await quota(A)).attempts_today, quotaBefore.attempts_today);
    assert.ok(await objectExists(target.storagePath));
    console.log(`  concurrent statuses: ${statuses.join(" ")}`);
  });

  test("Storage outage and short reads are retryable; nothing is lost", async () => {
    const bytes = pdfBytes();
    const d = await draft(A, [file("outage.pdf", bytes.length), file("short.pdf", bytes.length)]);
    for (const [target, mode] of [[d.uploads[0], "fail-download"], [d.uploads[1], "truncate-download"]] as const) {
      await upload(A, target, bytes);
      const flaky = await signedInClient(A.email, A.password, storageFetch(mode));
      const result = await processDocument(ctxFor(A, flaky), target.documentId);
      assert.ok(result.ok && result.data.status === "uploaded", `${mode}: ${JSON.stringify(result)}`);
      assert.equal(result.data.error?.code, "STORAGE_UNAVAILABLE");
      assert.equal(result.data.error?.retryable, true);
      assert.equal((await row(target.documentId)).processing_status, "uploaded", "left retryable, not stranded in processing");
      assert.ok(await objectExists(target.storagePath), "object kept");
      const retry = await processSettled(A, target.documentId);
      assert.ok(retry.ok && retry.data.status === "ready", `${mode} retry: ${JSON.stringify(retry)}`);
    }
  });

  test("cleanup failure is reported and retried safely on the next call", async () => {
    const garbage = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(300));
    const target = (await draft(A, [file("cleanup.pdf", garbage.length)])).uploads[0];
    await upload(A, target, garbage);
    const flakyAdmin = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: storageFetch("fail-delete") } });
    const first = await processDocument(ctxFor(A, A.db, flakyAdmin), target.documentId);
    assert.ok(first.ok && first.data.status === "failed" && first.data.cleanupPending === true, JSON.stringify(first));
    assert.ok(await objectExists(target.storagePath), "object still there after failed cleanup");
    const second = await processSettled(A, target.documentId);
    assert.ok(second.ok && second.data.status === "failed" && second.data.cleanupPending === undefined);
    assert.equal(await objectExists(target.storagePath), false, "cleanup completed on retry");
    const third = await processDocument(ctx(A), target.documentId);
    assert.ok(third.ok && third.data.status === "failed", "idempotent after cleanup");
  });

  test("successful objects are never deleted by any of the flows above", async () => {
    const { data } = await admin.from("source_documents").select("storage_path").eq("user_id", A.id).eq("processing_status", "ready");
    assert.ok((data ?? []).length >= 6, `expected ≥6 ready documents, found ${(data ?? []).length}`);
    for (const { storage_path } of data ?? []) assert.ok(await objectExists(storage_path as string), storage_path as string);
  });
});

describe("quota errors", () => {
  test("TQ001 daily uploads → QUOTA_DAILY_UPLOADS (whole draft rolled back)", async () => {
    const U = await makeUser();
    for (let i = 0; i < 6; i++) await draft(U, [file("a.pdf", 100), file("b.pdf", 100), file("c.pdf", 100)]); // 18
    const result = await createMaterialsDraft(ctx(U), draftInput([file("a.pdf", 100), file("b.pdf", 100), file("c.pdf", 100)]));
    assert.ok(!result.ok && result.error.code === "QUOTA_DAILY_UPLOADS", JSON.stringify(result));
    assert.equal((await quota(U)).attempts_today, 18, "nothing charged for the rejected draft");
  });

  test("TQ002 daily bytes → QUOTA_DAILY_BYTES", async () => {
    const U = await makeUser();
    const today = new Date().toISOString().slice(0, 10);
    const seed = await admin.from("upload_quota_usage").insert({ user_id: U.id, usage_date: today, attempts: 5, bytes: 195 * MiB });
    assert.equal(seed.error, null);
    const result = await createMaterialsDraft(ctx(U), draftInput([file("big.pdf", 6 * MiB)]));
    assert.ok(!result.ok && result.error.code === "QUOTA_DAILY_BYTES", JSON.stringify(result));
  });

  test("TQ003 stored bytes → QUOTA_STORAGE at registration", async () => {
    const U = await makeUser();
    for (let i = 0; i < 5; i++) await draft(U, [file("a.pdf", 10 * MiB), file("b.pdf", 10 * MiB), file("c.pdf", 10 * MiB)]);
    const result = await createMaterialsDraft(ctx(U), draftInput([file("one-more.pdf", 1)]));
    assert.ok(!result.ok && result.error.code === "QUOTA_STORAGE", JSON.stringify(result));
  });

  test("TQ003 during verification (actual size larger than declared) → failed QUOTA_STORAGE, object deleted", async () => {
    const U = await makeUser();
    for (let i = 0; i < 4; i++) await draft(U, [file("a.pdf", 10 * MiB), file("b.pdf", 10 * MiB), file("c.pdf", 10 * MiB)]); // 120 MiB
    await draft(U, [file("d.pdf", 10 * MiB), file("e.pdf", 10 * MiB)]); // 140 MiB
    const d = await draft(U, [file("f.pdf", 10 * MiB - 100), file("tiny.pdf", 1)]); // 150 MiB - 99 B
    const target = d.uploads[1];
    await upload(U, target, pdfBytes()); // ~1 KB actual vs 1 B declared → exceeds the stored cap
    const result = await processSettled(U, target.documentId);
    assert.ok(result.ok && result.data.status === "failed" && result.data.error?.code === "QUOTA_STORAGE", JSON.stringify(result));
    assert.equal(await objectExists(target.storagePath), false);
  });
});
