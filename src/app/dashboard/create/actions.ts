"use server";

import { unstable_rethrow } from "next/navigation";

import {
  createMaterialsDraftForCurrentUser,
  getPresentationDocumentsForCurrentUser,
  processDocumentForCurrentUser,
  type DraftResult,
  type PresentationDocumentsView,
  type ProcessResult,
  type ServiceResult,
} from "@/lib/server/documents";
import { safeError } from "@/lib/server/documents/errors";

/**
 * Thin Server Actions for materials-based presentations. Input is validated with Zod inside the
 * service; identity comes from the DAL (never from arguments). Unexpected exceptions become a
 * fixed INTERNAL_ERROR; Next.js redirects (expired session → /login) are rethrown.
 * Next.js also checks the Origin header of every Server Action request (CSRF).
 */

async function guard<T>(name: string, run: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    console.error(`[documents] action ${name} threw ${error instanceof Error ? error.name : "unknown"}`);
    return { ok: false, error: safeError("INTERNAL_ERROR") };
  }
}

/** Create a draft and register 1–3 files. Returns upload targets for the browser (no credentials). */
export async function createMaterialsDraftAction(input: unknown): Promise<ServiceResult<DraftResult>> {
  return guard("createMaterialsDraft", () => createMaterialsDraftForCurrentUser(input));
}

/** Verify an uploaded file and extract its text. Safe to call repeatedly and concurrently. */
export async function processDocumentAction(documentId: unknown): Promise<ServiceResult<ProcessResult>> {
  return guard("processDocument", () => processDocumentForCurrentUser(documentId));
}

/** The current user's draft with per-file status and quota, for the upcoming status UI. */
export async function getPresentationDocumentsAction(presentationId: unknown): Promise<ServiceResult<PresentationDocumentsView>> {
  return guard("getPresentationDocuments", () => getPresentationDocumentsForCurrentUser(presentationId));
}
