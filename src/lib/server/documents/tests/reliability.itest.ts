/**
 * TASK 005.4.1 failure-injection tests against the HOSTED DEVELOPMENT project only.
 *   npm run test:integration
 * - svc_fail_document failing (before and after the processing claim) and losing its response
 * - Storage download errors: confirmed-missing vs. unreadable (NoSuchKey while the object exists),
 *   generic 400 (InvalidRequest), NoSuchBucket (what an invalid JWT returns)
 * Disposable confirmed users (no email), small synthetic files, full cleanup.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, test } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { LESSON, makePdf } from "../../../documents/tests/fixtures.ts";
import { createMaterialsDraft, processDocument, SOURCE_BUCKET, type ServiceContext, type UploadTarget } from "../service.ts";

const DEV_REF = "gceuqyhuxpmnkmhhaivr";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
if (new URL(URL_).host !== `${DEV_REF}.supabase.co`) throw new Error("Refusing to run: not the teachmate-ai-dev project");

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_, SECRET, noPersist);
const createdUsers: string[] = [];
const logs: { event: string; fields: Record<string, unknown> }[] = [];

type Rule = "pass" | "reject" | "lose-response" | { status: number; body: unknown };
const urlOf = (input: Parameters<typeof fetch>[0]) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** fetch that applies `rule` to matching requests only (everything else passes through). */
function intercept(match: (url: string, method: string) => boolean, rule: Rule): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!match(urlOf(input), method) || rule === "pass") return fetch(input, init);
    if (rule === "reject") throw new TypeError("fetch failed (simulated)");
    if (rule === "lose-response") {
      const response = await fetch(input, init); // the request reaches the server and commits…
      await response.arrayBuffer();
      throw new TypeError("fetch failed (simulated: response lost)"); // …but the reply never arrives
    }
    return new Response(JSON.stringify(rule.body), { status: rule.status, headers: { "content-type": "application/json" } });
  };
}
const isFailRpc = (url: string) => url.includes("/rest/v1/rpc/svc_fail_document");
const isObjectGet = (url: string, method: string) => method === "GET" && url.includes("/storage/v1/object/");

/** Real Storage error bodies (shapes observed on the hosted project in the 005.4.1 probe). */
const STORAGE_BODIES = {
  NoSuchKey: { statusCode: "404", code: "NoSuchKey", error: "not_found", message: "Object not found" },
  NoSuchBucket: { statusCode: "404", code: "NoSuchBucket", error: "Bucket not found", message: "Bucket not found" },
  InvalidRequest: { statusCode: "400", code: "InvalidRequest", error: "Bad Request", message: "Invalid request" },
};

type TestUser = { id: string; email: string; password: string; db: SupabaseClient };

async function client(user: { email: string; password: string }, fetchImpl?: typeof fetch) {
  const db = createClient(URL_, PUBLISHABLE, { ...noPersist, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}) });
  const { error } = await db.auth.signInWithPassword(user);
  if (error) throw new Error(`sign-in failed: ${error.code}`);
  return db;
}

async function makeUser(): Promise<TestUser> {
  const email = `tm-e2e-${randomBytes(4).toString("hex")}@example.com`;
  const password = `E2e-${randomBytes(12).toString("base64url")}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser failed: ${error.code}`);
  createdUsers.push(data.user.id);
  return { id: data.user.id, email, password, db: await client({ email, password }) };
}

const ctx = (user: TestUser, overrides: Partial<ServiceContext> = {}, options: ServiceContext["options"] = {}): ServiceContext => ({
  userId: user.id,
  db: user.db,
  admin,
  log: (event, fields) => logs.push({ event, fields }),
  ...overrides,
  options: { retryDelayMs: 20, downloadAttempts: 2, failRecordAttempts: 2, ...options },
});

async function retrying<T>(run: () => PromiseLike<T>, transient: (value: T) => boolean, attempts = 4): Promise<T> {
  let value = await run();
  for (let attempt = 1; attempt < attempts && transient(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    value = await run();
  }
  return value;
}
const hasError = <T extends { error: unknown }>(r: T) => r.error !== null;

async function draftOne(user: TestUser, name: string, size: number): Promise<UploadTarget> {
  const result = await retrying(
    () => createMaterialsDraft(ctx(user), { title: "Reliability test", grade: "3", subject: "science", language: "english", theme: "crayon-box", slideCount: "10", files: [{ name, size }] }),
    (r) => !r.ok && r.error.retryable,
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result.data.uploads[0];
}

async function upload(user: TestUser, target: UploadTarget, bytes: Uint8Array) {
  const body = new Blob([new Uint8Array(bytes)], { type: target.contentType });
  const { error } = await retrying(() => user.db.storage.from(SOURCE_BUCKET).upload(target.storagePath, body, { upsert: false }), (r) => r.error !== null && !(r.error as { statusCode?: string }).statusCode);
  assert.ok(error === null || (await objectExists(target.storagePath)), `upload failed: ${error?.message}`);
}

async function objectExists(path: string) {
  const { data, error } = await retrying(() => admin.storage.from(SOURCE_BUCKET).exists(path).catch((e: unknown) => ({ data: null, error: e })), (r) => r.data === null);
  assert.notEqual(data, null, `exists check failed: ${String(error)}`);
  return data === true;
}

async function status(documentId: string) {
  const { data, error } = await retrying(() => admin.from("source_documents").select("processing_status, processing_error").eq("id", documentId).single(), hasError);
  assert.equal(error, null);
  return data as { processing_status: string; processing_error: string | null };
}

const garbagePdf = () => new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(400));
const goodPdf = () => makePdf([["Reliability", LESSON]]);

after(async () => {
  for (const userId of createdUsers) {
    const { data: folders } = await retrying(() => admin.storage.from(SOURCE_BUCKET).list(userId), hasError, 6);
    for (const folder of folders ?? []) {
      const { data: objects } = await retrying(() => admin.storage.from(SOURCE_BUCKET).list(`${userId}/${folder.name}`), hasError, 6);
      const paths = (objects ?? []).map((object) => `${userId}/${folder.name}/${object.name}`);
      if (paths.length) await retrying(() => admin.storage.from(SOURCE_BUCKET).remove(paths), hasError, 6);
    }
    await retrying(() => admin.auth.admin.deleteUser(userId), (r) => r.error !== null && r.error.status !== 404, 6);
  }
  const leftovers = {
    documents: (await admin.from("source_documents").select("id", { count: "exact", head: true }).in("user_id", createdUsers)).count,
    ledger: (await admin.from("upload_quota_usage").select("user_id", { count: "exact", head: true }).in("user_id", createdUsers)).count,
    users: (await Promise.all(createdUsers.map((id) => admin.auth.admin.getUserById(id)))).filter((r) => r.data?.user).length,
    objects: (await Promise.all(createdUsers.map((id) => admin.storage.from(SOURCE_BUCKET).list(id)))).reduce((n, r) => n + (r.data?.length ?? 0), 0),
  };
  console.log(`  cleanup: ${createdUsers.length} test users; leftovers ${JSON.stringify(leftovers)}`);
  assert.deepEqual(leftovers, { documents: 0, ledger: 0, users: 0, objects: 0 });
});

describe("svc_fail_document failure injection", () => {
  test("after the claim: unrecorded failure → retryable INTERNAL_ERROR, nothing deleted; a later call completes it", async () => {
    const U = await makeUser();
    const target = await draftOne(U, "broken.pdf", garbagePdf().length);
    await upload(U, target, garbagePdf());
    const failingAdmin = createClient(URL_, SECRET, { ...noPersist, global: { fetch: intercept(isFailRpc, "reject") } });

    const first = await processDocument(ctx(U, { admin: failingAdmin }), target.documentId);
    assert.ok(!first.ok, `must not report a document status: ${JSON.stringify(first)}`);
    assert.equal(first.error.code, "INTERNAL_ERROR");
    assert.equal(first.error.retryable, true);
    assert.equal((await status(target.documentId)).processing_status, "processing", "claimed, failure not recorded");
    assert.ok(await objectExists(target.storagePath), "object NOT deleted when the failure is unrecorded");
    assert.ok(logs.some((l) => l.event === "document.fail_not_recorded"));

    const fresh = await processDocument(ctx(U), target.documentId);
    assert.ok(fresh.ok && fresh.data.status === "processing" && fresh.data.error?.code === "PROCESSING_IN_PROGRESS", "a fresh row is left to its worker");
    assert.ok(await objectExists(target.storagePath));

    // Since migration 0800 the database refuses to fail a token attempt that changed less than
    // 2 minutes ago (its own clock), even when the app thinks it is stale.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const early = await processDocument(ctx(U, {}, { staleProcessingMs: 1 }), target.documentId);
    assert.ok(!early.ok && early.error.code === "INTERNAL_ERROR" && early.error.retryable, `live attempt not failed early: ${JSON.stringify(early)}`);
    assert.equal((await status(target.documentId)).processing_status, "processing");
    assert.ok(await objectExists(target.storagePath), "object kept while the attempt may be live");

    await new Promise((resolve) => setTimeout(resolve, 2 * 60_000 + 5_000)); // past the database's 2-minute window
    const recovered = await processDocument(ctx(U, {}, { staleProcessingMs: 1 }), target.documentId);
    assert.ok(recovered.ok && recovered.data.status === "failed", JSON.stringify(recovered));
    assert.equal(recovered.data.error?.code, "INTERNAL_ERROR");
    assert.equal(recovered.data.cleanupPending, undefined);
    assert.equal(await objectExists(target.storagePath), false, "deleted only after the failure was recorded");

    const again = await processDocument(ctx(U), target.documentId);
    assert.ok(again.ok && again.data.status === "failed", "idempotent");
  });

  test("before the claim (confirmed-missing object): unrecorded failure → retryable; retry records UPLOAD_MISSING", async () => {
    const U = await makeUser();
    const target = await draftOne(U, "vanishing.pdf", goodPdf().length);
    await upload(U, target, goodPdf());
    // Verify (pending_upload → uploaded) but stop at the download.
    const noDownloads = await client(U, intercept(isObjectGet, "reject"));
    const verified = await processDocument(ctx(U, { db: noDownloads }), target.documentId);
    assert.ok(verified.ok && verified.data.status === "uploaded" && verified.data.error?.code === "STORAGE_UNAVAILABLE");
    // The object really disappears.
    await retrying(() => admin.storage.from(SOURCE_BUCKET).remove([target.storagePath]), hasError);
    assert.equal(await objectExists(target.storagePath), false);

    const failingAdmin = createClient(URL_, SECRET, { ...noPersist, global: { fetch: intercept(isFailRpc, "reject") } });
    const unrecorded = await processDocument(ctx(U, { admin: failingAdmin }), target.documentId);
    assert.ok(!unrecorded.ok && unrecorded.error.code === "INTERNAL_ERROR" && unrecorded.error.retryable, JSON.stringify(unrecorded));
    assert.equal((await status(target.documentId)).processing_status, "uploaded", "unchanged");

    const retry = await processDocument(ctx(U), target.documentId);
    assert.ok(retry.ok && retry.data.status === "failed" && retry.data.error?.code === "UPLOAD_MISSING", JSON.stringify(retry));
    assert.equal((await status(target.documentId)).processing_error, "UPLOAD_MISSING");
  });

  test("lost response (RPC committed, reply lost) → fresh read confirms `failed`, then cleanup", async () => {
    const U = await makeUser();
    const target = await draftOne(U, "lost.pdf", garbagePdf().length);
    await upload(U, target, garbagePdf());
    const lossyAdmin = createClient(URL_, SECRET, { ...noPersist, global: { fetch: intercept(isFailRpc, "lose-response") } });
    const result = await processDocument(ctx(U, { admin: lossyAdmin }), target.documentId);
    assert.ok(result.ok && result.data.status === "failed" && result.data.error?.code === "MALFORMED_DOCUMENT", JSON.stringify(result));
    assert.equal(await objectExists(target.storagePath), false, "cleanup ran because the fresh read showed `failed`");
  });
});

describe("Storage download error classification", () => {
  test("NoSuchKey while the object exists (unreadable for this session) → retryable, never deleted", async () => {
    const U = await makeUser();
    const target = await draftOne(U, "unreadable.pdf", goodPdf().length);
    await upload(U, target, goodPdf());
    const lying = await client(U, intercept(isObjectGet, { status: 400, body: STORAGE_BODIES.NoSuchKey }));
    const result = await processDocument(ctx(U, { db: lying }), target.documentId);
    assert.ok(result.ok && result.data.status === "uploaded" && result.data.error?.code === "STORAGE_UNAVAILABLE", JSON.stringify(result));
    assert.ok(logs.some((l) => l.event === "storage.download_unreadable" && l.fields.confirmed === "present"));
    assert.ok(await objectExists(target.storagePath), "object kept");
    const retry = await processDocument(ctx(U), target.documentId);
    assert.ok(retry.ok && retry.data.status === "ready", JSON.stringify(retry));
  });

  for (const code of ["InvalidRequest", "NoSuchBucket"] as const) {
    test(`generic 400 (${code}) → retryable, row unchanged, object kept`, async () => {
      const U = await makeUser();
      const target = await draftOne(U, `${code}.pdf`, goodPdf().length);
      await upload(U, target, goodPdf());
      const erroring = await client(U, intercept(isObjectGet, { status: 400, body: STORAGE_BODIES[code] }));
      const result = await processDocument(ctx(U, { db: erroring }), target.documentId);
      assert.ok(result.ok && result.data.status === "uploaded" && result.data.error?.code === "STORAGE_UNAVAILABLE" && result.data.error.retryable, JSON.stringify(result));
      assert.equal((await status(target.documentId)).processing_status, "uploaded");
      assert.ok(await objectExists(target.storagePath), "object kept");
      const retry = await processDocument(ctx(U), target.documentId);
      assert.ok(retry.ok && retry.data.status === "ready", JSON.stringify(retry));
    });
  }

  test("logs never contain document text or storage messages", () => {
    assert.doesNotMatch(JSON.stringify(logs), /Photosynthesis|Object not found|Bucket not found/);
  });
});
