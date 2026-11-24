/**
 * Browser → Supabase Storage upload with real progress (XMLHttpRequest upload events; fetch has
 * none). Same REST endpoint and headers supabase-js uses for a raw-body upload:
 *   POST {SUPABASE_URL}/storage/v1/object/{bucket}/{path}
 *   Authorization: Bearer <the signed-in user's access token>   (RLS decides: owner + pending row)
 *   x-upsert: false                                             (never overwrite)
 *   Content-Type: <validated MIME>                              (body = file.slice(0, size, mime))
 * File bytes go straight to Storage, never through a Server Action. The server re-validates
 * everything afterwards; this module only reports what Storage answered.
 */

export type UploadOutcome =
  | { kind: "uploaded" }
  /** Storage refused a second write to this path: it may already hold our object (lost response). Let the server check. */
  | { kind: "maybe_exists" }
  | { kind: "failed"; retryable: boolean; code: "NETWORK" | "SESSION" | "TOO_LARGE" | "TYPE_REJECTED" | "STORAGE" };

export type UploadRequest = {
  supabaseUrl: string;
  publishableKey: string;
  accessToken: string;
  bucket: string;
  path: string;
  file: Blob;
  contentType: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
};

/** Storage error body → outcome. Exported for unit tests. */
export function classifyUploadResponse(status: number, body: unknown): UploadOutcome {
  if (status >= 200 && status < 300) return { kind: "uploaded" };
  const b = (body && typeof body === "object" ? body : {}) as { statusCode?: unknown; error?: unknown; message?: unknown };
  const statusCode = String(b.statusCode ?? status);
  const text = `${String(b.error ?? "")} ${String(b.message ?? "")}`.toLowerCase();
  if (statusCode === "409" || text.includes("already exists") || text.includes("duplicate")) return { kind: "maybe_exists" };
  // RLS rejects writes once the row is no longer `pending_upload` (e.g. our object landed and was
  // verified) — the server decides what actually happened.
  if (statusCode === "403" || text.includes("row-level security")) return { kind: "maybe_exists" };
  if (statusCode === "413" || text.includes("exceeded the maximum allowed size")) return { kind: "failed", retryable: false, code: "TOO_LARGE" };
  if (statusCode === "415" || text.includes("mime type")) return { kind: "failed", retryable: false, code: "TYPE_REJECTED" };
  if (statusCode === "401" || text.includes("jwt") || text.includes("unauthorized")) return { kind: "failed", retryable: true, code: "SESSION" };
  return { kind: "failed", retryable: true, code: "STORAGE" };
}

export function uploadToStorage(request: UploadRequest): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const path = request.path.split("/").map(encodeURIComponent).join("/");
    xhr.open("POST", `${request.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(request.bucket)}/${path}`);
    xhr.setRequestHeader("authorization", `Bearer ${request.accessToken}`);
    xhr.setRequestHeader("apikey", request.publishableKey);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.setRequestHeader("content-type", request.contentType);
    xhr.timeout = 5 * 60 * 1000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) request.onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      resolve(classifyUploadResponse(xhr.status, body));
    };
    xhr.onerror = () => resolve({ kind: "failed", retryable: true, code: "NETWORK" });
    xhr.ontimeout = () => resolve({ kind: "failed", retryable: true, code: "NETWORK" });
    xhr.onabort = () => resolve({ kind: "failed", retryable: true, code: "NETWORK" });
    request.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    // Re-typed Blob (no copy): the validated MIME type travels with the body.
    xhr.send(request.file.slice(0, request.file.size, request.contentType));
  });
}

/** Fixed copy for upload outcomes (Storage messages are never shown). */
export const UPLOAD_MESSAGES: Record<Exclude<UploadOutcome, { kind: "uploaded" } | { kind: "maybe_exists" }>["code"], string> = {
  NETWORK: "The upload was interrupted. Check your connection and try again.",
  SESSION: "Your session needs refreshing. Try again, or sign in again if this keeps happening.",
  TOO_LARGE: "This file is larger than 10 MB.",
  TYPE_REJECTED: "Only PDF and DOCX files can be uploaded.",
  STORAGE: "We couldn’t upload this file right now. Please try again.",
};
