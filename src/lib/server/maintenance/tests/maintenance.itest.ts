/**
 * TASK 005.6 maintenance tests against the HOSTED DEVELOPMENT project only.
 *   npm run test:integration
 * Real Storage + database. Ages cannot be backdated on the hosted project (the updated_at
 * trigger), so handler re-check thresholds are lowered via options; the SQL thresholds themselves
 * are verified on local PostgreSQL. Disposable users (no email), full cleanup.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { LESSON, makePdf } from "../../../documents/tests/fixtures.ts";
import { processDocument } from "../../documents/service.ts";
import {
  cleanupDocument,
  cleanupOrphans,
  failStuckGeneration,
  pruneQuotaLedger,
  recoverStuckDocument,
  resumePresentationDeletion,
  runMaintenance,
  type MaintenanceContext,
  type MaintenanceOptions,
} from "../service.ts";

const DEV_REF = "gceuqyhuxpmnkmhhaivr";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
if (new URL(URL_).host !== `${DEV_REF}.supabase.co`) throw new Error("Refusing to run: not the teachmate-ai-dev project");

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_, SECRET, noPersist);
const BUCKET = "source-materials";
const createdUsers: string[] = [];
const logs: { event: string; fields: Record<string, unknown> }[] = [];

// "Old enough right now". The client-side thresholds compare this machine's clock with database
// timestamps; a local clock behind the server (measured ~0.3–0.5 s here) made a 0 ms threshold
// see a row updated a moment ago as being in the future, so it was (correctly) skipped. A
// negative threshold tolerates that skew. "Fresh" checks use the real defaults (mctx({})).
const CLOCK_SKEW_TOLERANCE_MS = -60_000;
const NOW: MaintenanceOptions = {
  pendingUploadMaxAgeMs: CLOCK_SKEW_TOLERANCE_MS,
  stuckProcessingMs: CLOCK_SKEW_TOLERANCE_MS,
  deletingResumeMs: CLOCK_SKEW_TOLERANCE_MS,
  failedRetentionMs: CLOCK_SKEW_TOLERANCE_MS,
  stuckGenerationMs: CLOCK_SKEW_TOLERANCE_MS,
  orphanMinAge: "0 seconds", // evaluated inside the database: no skew
};
const mctx = (options: MaintenanceOptions = NOW, client: SupabaseClient = admin): MaintenanceContext => ({
  admin: client,
  log: (event, fields) => logs.push({ event, fields }),
  options,
});

type Rule = (url: string, method: string) => boolean;
function failing(rule: Rule): SupabaseClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (rule(url, method)) throw new TypeError("fetch failed (simulated)");
    return fetch(input, init);
  };
  return createClient(URL_, SECRET, { ...noPersist, global: { fetch: fetchImpl } });
}

type TestUser = { id: string; db: SupabaseClient };
async function makeUser(): Promise<TestUser> {
  const email = `tm-e2e-${randomBytes(4).toString("hex")}@example.com`;
  const password = `E2e-${randomBytes(12).toString("base64url")}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser failed: ${error.code}`);
  createdUsers.push(data.user.id);
  const db = createClient(URL_, PUBLISHABLE, noPersist);
  const signIn = await db.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.code}`);
  return { id: data.user.id, db };
}

type Doc = { id: string; path: string; presentationId: string };
async function draft(user: TestUser, count = 1): Promise<Doc[]> {
  const pdf = makePdf([["Maintenance", LESSON]]);
  const { data, error } = await user.db.rpc("create_materials_draft", {
    p_title: "Maintenance test", p_grade_level: 3, p_subject: "science", p_language: "english", p_theme: "crayon-box", p_slide_count: 10,
    p_files: Array.from({ length: count }, (_, i) => ({ name: `f${i}.pdf`, type: "pdf", size: pdf.length })),
  });
  if (error) throw new Error(`draft failed: ${error.code}`);
  return (data as { out_document_id: string; out_storage_path: string }[]).map((row) => ({
    id: row.out_document_id,
    path: row.out_storage_path,
    presentationId: row.out_storage_path.split("/")[1],
  }));
}
const putObject = async (path: string) => {
  const { error } = await admin.storage.from(BUCKET).upload(path, new Blob([new Uint8Array(makePdf([["Maintenance", LESSON]]))], { type: "application/pdf" }), { upsert: false });
  assert.equal(error, null, `put failed: ${error?.message}`);
};
const exists = async (path: string) => (await admin.storage.from(BUCKET).exists(path)).data === true;
const status = async (id: string) => ((await admin.from("source_documents").select("processing_status, processing_error").eq("id", id).maybeSingle()).data ?? null) as { processing_status: string; processing_error: string | null } | null;
const userCtx = (user: TestUser) => ({ userId: user.id, db: user.db, admin, log: () => {}, options: { retryDelayMs: 20 } });

after(async () => {
  for (const userId of createdUsers) {
    const { data: folders } = await admin.storage.from(BUCKET).list(userId);
    for (const folder of folders ?? []) {
      const { data: objects } = await admin.storage.from(BUCKET).list(`${userId}/${folder.name}`);
      const paths = (objects ?? []).map((o) => `${userId}/${folder.name}/${o.name}`);
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
    }
    await admin.auth.admin.deleteUser(userId);
  }
  const leftovers = {
    documents: (await admin.from("source_documents").select("id", { count: "exact", head: true }).in("user_id", createdUsers)).count,
    presentations: (await admin.from("presentations").select("id", { count: "exact", head: true }).in("user_id", createdUsers)).count,
    users: (await Promise.all(createdUsers.map((id) => admin.auth.admin.getUserById(id)))).filter((r) => r.data?.user).length,
    objects: (await Promise.all(createdUsers.map((id) => admin.storage.from(BUCKET).list(id)))).reduce((n, r) => n + (r.data?.length ?? 0), 0),
  };
  console.log(`  cleanup: ${createdUsers.length} test users; leftovers ${JSON.stringify(leftovers)}`);
  assert.deepEqual(leftovers, { documents: 0, presentations: 0, users: 0, objects: 0 });
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(createdUsers.join("|") || "^$"), "logs never contain ids or paths");
});

describe("pending uploads", () => {
  test("abandoned pending upload: row removed, with or without an object; fresh ones untouched", async () => {
    const U = await makeUser();
    const [noObject, withObject] = await draft(U, 2);
    const [fresh] = await draft(U, 1);
    await putObject(withObject.path);

    assert.deepEqual(await cleanupDocument(mctx(), U.id, noObject.id), { outcome: "done", kind: "pending" });
    assert.deepEqual(await cleanupDocument(mctx(), U.id, withObject.id), { outcome: "done", kind: "pending" });
    assert.equal(await status(noObject.id), null);
    assert.equal(await status(withObject.id), null);
    assert.equal(await exists(withObject.path), false, "object removed before the row");

    assert.deepEqual(await cleanupDocument(mctx({}), U.id, fresh.id), { outcome: "skipped" }, "default 24 h threshold");
    assert.equal((await status(fresh.id))?.processing_status, "pending_upload");
  });
});

describe("stuck processing", () => {
  test("processing → failed (object removed); ready, uploaded and fresh rows untouched", async () => {
    const U = await makeUser();
    const [stuck, ready, uploaded] = await draft(U, 3);
    for (const doc of [stuck, ready, uploaded]) await putObject(doc.path);
    // stuck: verified and claimed, then the request "died".
    for (const fn of ["svc_mark_document_verified", "svc_start_document_processing"]) assert.equal((await admin.rpc(fn, { p_user_id: U.id, p_document_id: stuck.id })).error, null);
    // ready: processed normally. uploaded: verified only.
    assert.equal((await processDocument(userCtx(U), ready.id)).ok, true);
    assert.equal((await admin.rpc("svc_mark_document_verified", { p_user_id: U.id, p_document_id: uploaded.id })).error, null);

    // A LIVE token attempt (migration 0800) is never failed, even when the app-side threshold
    // says "old enough" (here −60 s): the database refuses token attempts younger than 2 minutes.
    const [live] = await draft(U, 1);
    await putObject(live.path);
    assert.equal((await admin.rpc("svc_mark_document_verified", { p_user_id: U.id, p_document_id: live.id })).error, null);
    assert.equal((await admin.rpc("svc_claim_document_processing", { p_user_id: U.id, p_document_id: live.id })).error, null);
    assert.deepEqual(await recoverStuckDocument(mctx(), U.id, live.id), { outcome: "skipped" }, "live attempt refused by the database");
    assert.equal((await status(live.id))?.processing_status, "processing");
    assert.ok(await exists(live.path), "live attempt's object kept");

    // stuck (legacy, token-less claim, as an old app instance leaves it) is recovered at once.
    assert.deepEqual(await recoverStuckDocument(mctx({}), U.id, stuck.id), { outcome: "skipped" }, "fresh: default 15 min");
    assert.deepEqual(await recoverStuckDocument(mctx(), U.id, stuck.id), { outcome: "done" });
    assert.deepEqual(await status(stuck.id), { processing_status: "failed", processing_error: "INTERNAL_ERROR" });
    assert.equal(await exists(stuck.path), false);
    assert.deepEqual(await recoverStuckDocument(mctx(), U.id, stuck.id), { outcome: "skipped" }, "idempotent");

    assert.deepEqual(await recoverStuckDocument(mctx(), U.id, ready.id), { outcome: "skipped" });
    assert.equal((await status(ready.id))?.processing_status, "ready");
    assert.ok(await exists(ready.path), "ready object kept");
    assert.deepEqual(await recoverStuckDocument(mctx(), U.id, uploaded.id), { outcome: "skipped", awaitingTeacher: true });
    assert.equal((await status(uploaded.id))?.processing_status, "uploaded");
    assert.ok(await exists(uploaded.path), "uploaded object kept for the teacher");
  });
});

describe("deletion", () => {
  test("document deletion: Storage failure leaves it resumable; the next run completes it", async () => {
    const U = await makeUser();
    const [doc] = await draft(U, 1);
    await putObject(doc.path);
    assert.equal((await admin.rpc("svc_begin_document_deletion", { p_user_id: U.id, p_document_id: doc.id })).error, null);
    const noDeletes = failing((url, method) => url.includes("/storage/v1/object/") && method === "DELETE");
    assert.deepEqual(await cleanupDocument(mctx(NOW, noDeletes), U.id, doc.id), { outcome: "error", kind: "deleting" });
    assert.equal((await status(doc.id))?.processing_status, "deleting", "row kept while the object exists");
    assert.ok(await exists(doc.path));
    assert.deepEqual(await cleanupDocument(mctx(), U.id, doc.id), { outcome: "done", kind: "deleting" });
    assert.equal(await status(doc.id), null);
    assert.equal(await exists(doc.path), false);
  });

  test("presentation deletion: removes tracked and untracked objects, then the presentation; active presentation untouched", async () => {
    const U = await makeUser();
    const docs = await draft(U, 2);
    const [active] = await draft(U, 1);
    const presentationId = docs[0].presentationId;
    const untracked = `${U.id}/${presentationId}/${randomUUID()}.pdf`;
    for (const path of [...docs.map((d) => d.path), untracked, active.path]) await putObject(path);
    assert.equal((await processDocument(userCtx(U), active.id)).ok, true);
    assert.equal((await admin.rpc("svc_begin_presentation_deletion", { p_user_id: U.id, p_presentation_id: presentationId })).error, null);

    assert.equal(await resumePresentationDeletion(mctx(), U.id, active.presentationId), "skipped", "not being deleted");
    assert.equal(await resumePresentationDeletion(mctx(), U.id, presentationId), "done");
    assert.equal((await admin.from("presentations").select("id").eq("id", presentationId).maybeSingle()).data, null);
    for (const path of [...docs.map((d) => d.path), untracked]) assert.equal(await exists(path), false, "object removed");
    assert.equal((await status(active.id))?.processing_status, "ready");
    assert.ok(await exists(active.path), "active presentation's material kept");
    assert.equal(await resumePresentationDeletion(mctx(), U.id, presentationId), "skipped", "idempotent");
  });
});

describe("orphans", () => {
  test("confirmed orphans removed; unrecognized paths and failed lookups never deleted; bounded batches", async () => {
    const U = await makeUser();
    const docs = await draft(U, 3);
    for (const doc of docs) await putObject(doc.path);
    // Rows deleted directly (as an account/cascade deletion would) → objects become orphans.
    assert.equal((await admin.from("source_documents").delete().in("id", docs.map((d) => d.id))).error, null);
    const unrecognized = `${U.id}/misc/notes.pdf`;
    await putObject(unrecognized);

    const lookupsFail = failing((url, method) => url.includes("/rest/v1/source_documents") && method === "HEAD" || (url.includes("/rest/v1/source_documents") && method === "GET"));
    const blind = await cleanupOrphans(mctx(NOW, lookupsFail));
    assert.equal(blind.removed, 0, "a failed lookup is never treated as proof");
    assert.ok(blind.errors >= 3);
    for (const doc of docs) assert.ok(await exists(doc.path));

    const first = await cleanupOrphans(mctx({ ...NOW, orphanLimit: 100 }));
    assert.equal(first.removed, 3, JSON.stringify(first));
    assert.ok(first.skipped >= 1, "unrecognized path skipped");
    assert.ok(await exists(unrecognized), "objects this app didn't create are never deleted");
    for (const doc of docs) assert.equal(await exists(doc.path), false);
    await admin.storage.from(BUCKET).remove([unrecognized]);
  });

  test("bounded batch: one orphan per run with orphanLimit 1", async () => {
    const U = await makeUser();
    const docs = await draft(U, 3);
    for (const doc of docs) await putObject(doc.path);
    assert.equal((await admin.from("source_documents").delete().in("id", docs.map((d) => d.id))).error, null);
    const removedPerRun: number[] = [];
    for (let i = 0; i < 4; i++) removedPerRun.push((await cleanupOrphans(mctx({ ...NOW, orphanLimit: 1 }))).removed);
    assert.deepEqual(removedPerRun, [1, 1, 1, 0]);
  });
});

describe("ledger, generation, cross-user, failures, repeat runs", () => {
  test("quota ledger: rows older than 7 days pruned, recent kept", async () => {
    const U = await makeUser();
    await draft(U, 1); // today's row
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await admin.from("upload_quota_usage").insert([{ user_id: U.id, usage_date: day(10), attempts: 1, bytes: 1 }, { user_id: U.id, usage_date: day(3), attempts: 1, bytes: 1 }])).error, null);
    const result = await pruneQuotaLedger(mctx());
    assert.ok(!result.error && result.pruned >= 1);
    const { data } = await admin.from("upload_quota_usage").select("usage_date").eq("user_id", U.id).order("usage_date");
    assert.deepEqual((data ?? []).map((r) => r.usage_date), [day(3), day(0)]);
  });

  test("stuck generation → failed", async () => {
    const U = await makeUser();
    const [doc] = await draft(U, 1);
    await putObject(doc.path);
    assert.equal((await processDocument(userCtx(U), doc.id)).ok, true);
    assert.equal((await admin.rpc("svc_begin_generation", { p_user_id: U.id, p_presentation_id: doc.presentationId })).error, null);
    assert.equal(await failStuckGeneration(mctx({}), U.id, doc.presentationId), "skipped", "fresh");
    assert.equal(await failStuckGeneration(mctx(), U.id, doc.presentationId), "done");
    const { data } = await admin.from("presentations").select("status").eq("id", doc.presentationId).single();
    assert.equal(data?.status, "failed");
  });

  test("cross-user: a candidate with the wrong owner id never touches the row", async () => {
    const A = await makeUser();
    const B = await makeUser();
    const [pending] = await draft(A, 1);
    const [stuck] = await draft(A, 1);
    await putObject(stuck.path);
    for (const fn of ["svc_mark_document_verified", "svc_start_document_processing"]) await admin.rpc(fn, { p_user_id: A.id, p_document_id: stuck.id });
    await admin.rpc("svc_begin_presentation_deletion", { p_user_id: A.id, p_presentation_id: pending.presentationId });
    assert.deepEqual(await cleanupDocument(mctx(), B.id, pending.id), { outcome: "skipped" });
    assert.deepEqual(await recoverStuckDocument(mctx(), B.id, stuck.id), { outcome: "skipped" });
    assert.equal(await resumePresentationDeletion(mctx(), B.id, pending.presentationId), "skipped");
    assert.equal((await status(pending.id))?.processing_status, "pending_upload");
    assert.equal((await status(stuck.id))?.processing_status, "processing");
    assert.ok(await exists(stuck.path));
  });

  test("database failure: the run reports errors without throwing or deleting", async () => {
    const noRpc = failing((url) => url.includes("/rest/v1/rpc/"));
    const summary = await runMaintenance(mctx({}, noRpc));
    assert.ok(summary.errors >= 1);
    assert.equal(summary.orphansRemoved + summary.pendingUploadsRemoved + summary.documentDeletionsCompleted, 0);
  });

  test("repeated scheduled runs (real thresholds) are safe and change nothing valid", async () => {
    const U = await makeUser();
    const [ready, pending] = await draft(U, 2);
    await putObject(ready.path);
    assert.equal((await processDocument(userCtx(U), ready.id)).ok, true);
    const first = await runMaintenance(mctx({}));
    const second = await runMaintenance(mctx({}));
    for (const summary of [first, second]) {
      assert.equal(summary.errors, 0, JSON.stringify(summary));
      assert.equal(summary.timedOut, false);
    }
    assert.equal((await status(ready.id))?.processing_status, "ready");
    assert.ok(await exists(ready.path));
    assert.equal((await status(pending.id))?.processing_status, "pending_upload", "a fresh pending upload is not abandoned");
  });
});
