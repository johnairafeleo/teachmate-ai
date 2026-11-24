/**
 * TASK 005.5 frontend-workflow integration tests against the HOSTED DEVELOPMENT project only.
 * Exercises the exact Storage request the browser uploader sends (same endpoint, headers and
 * re-typed Blob body as storage-upload.ts; fetch instead of XHR), then the server actions' logic.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { classifyUploadResponse } from "../../../../components/create/upload/storage-upload.ts";
import { LESSON, makeDocx, makePdf } from "../../../documents/tests/fixtures.ts";
import { createMaterialsDraft, getPresentationDocuments, processDocument, SOURCE_BUCKET, type ServiceContext } from "../service.ts";

const DEV_REF = "gceuqyhuxpmnkmhhaivr";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
if (new URL(URL_).host !== `${DEV_REF}.supabase.co`) throw new Error("Refusing to run: not the teachmate-ai-dev project");

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_, SECRET, noPersist);
const createdUsers: string[] = [];
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type TestUser = { id: string; db: SupabaseClient; token: string };

async function makeUser(): Promise<TestUser> {
  const email = `tm-e2e-${randomBytes(4).toString("hex")}@example.com`;
  const password = `E2e-${randomBytes(12).toString("base64url")}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser failed: ${error.code}`);
  createdUsers.push(data.user.id);
  const db = createClient(URL_, PUBLISHABLE, noPersist);
  const { data: session, error: signInError } = await db.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`sign-in failed: ${signInError.code}`);
  return { id: data.user.id, db, token: session.session.access_token };
}

const ctx = (user: TestUser): ServiceContext => ({ userId: user.id, db: user.db, admin, log: () => {}, options: { retryDelayMs: 20 } });

/** Same request as uploadToStorage() in the browser (minus XHR progress events). */
async function browserUpload(user: TestUser, path: string, file: Blob, contentType: string) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${URL_}/storage/v1/object/${SOURCE_BUCKET}/${encoded}`, {
    method: "POST",
    headers: { authorization: `Bearer ${user.token}`, apikey: PUBLISHABLE, "x-upsert": "false", "cache-control": "max-age=3600", "content-type": contentType },
    body: file.slice(0, file.size, contentType),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return classifyUploadResponse(response.status, body);
}

const settings = { title: "Frontend workflow", grade: "5", subject: "science", language: "taglish", theme: "space-galaxy", slideCount: "12" };

after(async () => {
  for (const userId of createdUsers) {
    const { data: folders } = await admin.storage.from(SOURCE_BUCKET).list(userId);
    for (const folder of folders ?? []) {
      const { data: objects } = await admin.storage.from(SOURCE_BUCKET).list(`${userId}/${folder.name}`);
      const paths = (objects ?? []).map((object) => `${userId}/${folder.name}/${object.name}`);
      if (paths.length) await admin.storage.from(SOURCE_BUCKET).remove(paths);
    }
    const r = await admin.auth.admin.deleteUser(userId);
    if (r.error && r.error.status !== 404) await admin.auth.admin.deleteUser(userId);
  }
  const leftovers = {
    documents: (await admin.from("source_documents").select("id", { count: "exact", head: true }).in("user_id", createdUsers)).count,
    users: (await Promise.all(createdUsers.map((id) => admin.auth.admin.getUserById(id)))).filter((r) => r.data?.user).length,
  };
  console.log(`  cleanup: ${createdUsers.length} test users; leftovers ${JSON.stringify(leftovers)}`);
  assert.deepEqual(leftovers, { documents: 0, users: 0 });
});

describe("browser upload request (same as the XHR uploader)", () => {
  test("single file: direct upload with validated MIME, upsert:false, then ready", async () => {
    const U = await makeUser();
    const pdf = makePdf([["Frontend flow", LESSON]]);
    const draft = await createMaterialsDraft(ctx(U), { ...settings, files: [{ name: "lesson.pdf", size: pdf.length, mimeType: "application/pdf" }] });
    assert.ok(draft.ok);
    const target = draft.data.uploads[0];
    // A browser File with an empty type: the re-typed slice carries the validated MIME.
    const outcome = await browserUpload(U, target.storagePath, new Blob([new Uint8Array(pdf)], { type: "" }), target.contentType);
    assert.deepEqual(outcome, { kind: "uploaded" });
    const { data: info } = await admin.storage.from(SOURCE_BUCKET).info(target.storagePath);
    assert.equal(info?.contentType ?? (info as { metadata?: { mimetype?: string } } | null)?.metadata?.mimetype, "application/pdf");
    const duplicate = await browserUpload(U, target.storagePath, new Blob([new Uint8Array(pdf)]), target.contentType);
    assert.equal(duplicate.kind, "maybe_exists", "a second write is refused (upsert:false), and the UI defers to the server");
    const processed = await processDocument(ctx(U), target.documentId);
    assert.ok(processed.ok && processed.data.status === "ready", JSON.stringify(processed));
  });

  test("three files (PDF + DOCX with empty browser MIME + PDF): all ready; settings in the status view", async () => {
    const U = await makeUser();
    const files = [makePdf([["One", LESSON]]), makeDocx(), makePdf([["Three", LESSON]])];
    const draft = await createMaterialsDraft(ctx(U), {
      ...settings,
      files: [{ name: "one.pdf", size: files[0].length }, { name: "two.docx", size: files[1].length, mimeType: "" }, { name: "three.pdf", size: files[2].length }],
    });
    assert.ok(draft.ok);
    for (const [index, target] of draft.data.uploads.entries()) {
      assert.deepEqual(await browserUpload(U, target.storagePath, new Blob([new Uint8Array(files[index])]), target.contentType), { kind: "uploaded" });
      const processed = await processDocument(ctx(U), target.documentId);
      assert.ok(processed.ok && processed.data.status === "ready", `${target.fileName}: ${JSON.stringify(processed)}`);
    }
    const view = await getPresentationDocuments(ctx(U), draft.data.presentationId);
    assert.ok(view.ok);
    assert.deepEqual(view.data.settings, { grade: 5, subject: "science", language: "taglish", theme: "space-galaxy", slideCount: 12 });
    assert.equal(view.data.title, "Frontend workflow");
    assert.deepEqual(view.data.documents.map((d) => d.status), ["ready", "ready", "ready"]);
    assert.ok(view.data.documents.every((d) => d.upload === undefined && d.extract && d.extract.charCount > 0), "no upload targets once uploaded; extract summary present");
    // Documents of one draft share created_at, so list order is stable (by id) but not upload order.
    assert.equal(view.data.documents.find((d) => d.fileType === "docx")?.extract?.pageCount, null);
    assert.ok(view.data.documents.filter((d) => d.fileType === "pdf").every((d) => d.extract?.pageCount === 1));
  });

  test("partial failure, then refresh recovery from the status view", async () => {
    const U = await makeUser();
    const pdf = makePdf([["Partial", LESSON]]);
    const docx = makeDocx();
    const draft = await createMaterialsDraft(ctx(U), { ...settings, files: [{ name: "ok.pdf", size: pdf.length }, { name: "lost.docx", size: docx.length }] });
    assert.ok(draft.ok);
    const [okTarget, lostTarget] = draft.data.uploads;
    await browserUpload(U, okTarget.storagePath, new Blob([new Uint8Array(pdf)]), okTarget.contentType);
    // lost.docx: the tab was closed before its upload finished.
    const ok = await processDocument(ctx(U), okTarget.documentId);
    const lost = await processDocument(ctx(U), lostTarget.documentId);
    assert.ok(ok.ok && ok.data.status === "ready");
    assert.ok(lost.ok && lost.data.status === "pending_upload" && lost.data.error?.code === "UPLOAD_INCOMPLETE" && lost.data.error.retryable, JSON.stringify(lost));

    // After a refresh the page only has the server's view.
    const view = await getPresentationDocuments(ctx(U), draft.data.presentationId);
    assert.ok(view.ok);
    const pending = view.data.documents.find((d) => d.documentId === lostTarget.documentId);
    assert.equal(pending?.status, "pending_upload");
    assert.deepEqual(pending?.upload, { storagePath: lostTarget.storagePath, contentType: DOCX_MIME, maxBytes: 10 * 1024 * 1024 });
    assert.equal(view.data.documents.find((d) => d.documentId === okTarget.documentId)?.upload, undefined);

    // "Upload this file again" on the status page uses exactly that target.
    assert.deepEqual(await browserUpload(U, pending!.upload!.storagePath, new Blob([new Uint8Array(docx)]), pending!.upload!.contentType), { kind: "uploaded" });
    const recovered = await processDocument(ctx(U), lostTarget.documentId);
    assert.ok(recovered.ok && recovered.data.status === "ready", JSON.stringify(recovered));
  });

  test("processing failure is final (no retry), the object is removed", async () => {
    const U = await makeUser();
    const garbage = new TextEncoder().encode("%PDF-1.4\n" + "z".repeat(500));
    const draft = await createMaterialsDraft(ctx(U), { ...settings, files: [{ name: "broken.pdf", size: garbage.length }] });
    assert.ok(draft.ok);
    const target = draft.data.uploads[0];
    await browserUpload(U, target.storagePath, new Blob([new Uint8Array(garbage)]), target.contentType);
    const result = await processDocument(ctx(U), target.documentId);
    assert.ok(result.ok && result.data.status === "failed" && result.data.error?.code === "MALFORMED_DOCUMENT" && result.data.error.retryable === false);
    const view = await getPresentationDocuments(ctx(U), draft.data.presentationId);
    assert.ok(view.ok && view.data.documents[0].status === "failed" && view.data.documents[0].error?.code === "MALFORMED_DOCUMENT");
  });

  test("another user's token cannot upload to the path; status page is not found for them", async () => {
    const owner = await makeUser();
    const intruder = await makeUser();
    const pdf = makePdf([["Private", LESSON]]);
    const draft = await createMaterialsDraft(ctx(owner), { ...settings, files: [{ name: "private.pdf", size: pdf.length }] });
    assert.ok(draft.ok);
    const target = draft.data.uploads[0];
    const attempt = await browserUpload(intruder, target.storagePath, new Blob([new Uint8Array(pdf)]), target.contentType);
    assert.equal(attempt.kind, "maybe_exists", "RLS refuses the write (the UI would then ask the server, which says not found)");
    const { data: exists } = await admin.storage.from(SOURCE_BUCKET).exists(target.storagePath);
    assert.equal(exists, false, "nothing was written");
    const view = await getPresentationDocuments(ctx(intruder), draft.data.presentationId);
    assert.ok(!view.ok && view.error.code === "NOT_FOUND");
    const process = await processDocument(ctx(intruder), target.documentId);
    assert.ok(!process.ok && process.error.code === "NOT_FOUND");
  });

  test("invalid and unknown presentation ids", async () => {
    const U = await makeUser();
    for (const bad of ["not-a-uuid", "", "../etc", 42, null]) {
      const view = await getPresentationDocuments(ctx(U), bad);
      assert.ok(!view.ok && view.error.code === "INVALID_INPUT", JSON.stringify(bad));
    }
    const unknown = await getPresentationDocuments(ctx(U), randomUUID());
    assert.ok(!unknown.ok && unknown.error.code === "NOT_FOUND");
  });
});
