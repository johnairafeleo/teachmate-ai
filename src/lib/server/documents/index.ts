import "server-only";

import { requireUser, requireVerifiedUser } from "@/lib/auth/dal";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  createMaterialsDraft,
  getPresentationDocuments,
  processDocumentAuthenticated,
  type DraftResult,
  type PresentationDocumentsView,
  type ProcessResult,
  type ServiceContext,
  type ServiceResult,
} from "./service.ts";

/**
 * Server-only entry points for the current request. Identity always comes from the DAL:
 * - mutations use requireVerifiedUser() (Auth server check; redirects to /login if invalid),
 * - reads use requireUser() (verified JWT claims; RLS still applies to every query).
 * The user-scoped client is created from the same request cookies, so `userId` and the
 * session RLS sees always belong to the same person. The admin client never leaves this module
 * except inside the context passed to the service.
 */

async function verifiedContext(): Promise<ServiceContext> {
  const user = await requireVerifiedUser();
  return { userId: user.id, db: await createClient(), admin: createAdminClient() };
}

export async function createMaterialsDraftForCurrentUser(input: unknown): Promise<ServiceResult<DraftResult>> {
  return createMaterialsDraft(await verifiedContext(), input);
}

export async function processDocumentForCurrentUser(documentId: unknown): Promise<ServiceResult<ProcessResult>> {
  // The budget starts before verifiedContext() (requireVerifiedUser → getUser), so the Auth
  // round trip counts against it.
  return processDocumentAuthenticated(verifiedContext, documentId);
}

export async function getPresentationDocumentsForCurrentUser(presentationId: unknown): Promise<ServiceResult<PresentationDocumentsView>> {
  const user = await requireUser();
  return getPresentationDocuments({ userId: user.id, db: await createClient() }, presentationId);
}

export type { DraftResult, PresentationDocumentsView, ProcessResult, ServiceResult } from "./service.ts";
export type { SafeError, DocumentErrorCode } from "./errors.ts";
