/**
 * Classification of Supabase Storage download errors (observed on the hosted project, TASK 005.4.1):
 *
 *   missing object                 HTTP 400, statusCode "404", code "NoSuchKey"
 *   other user's object / anon     HTTP 400, statusCode "404", code "NoSuchKey"   ← same as missing!
 *   malformed or invalid JWT       HTTP 400, statusCode "404", code "NoSuchBucket"
 *   nonexistent bucket             HTTP 400, statusCode "404", code "NoSuchBucket"
 *   invalid key (e.g. empty path)  HTTP 400, statusCode "400", code "InvalidKey"
 *   network failure                StorageUnknownError (no status, no code)
 *
 * Storage answers almost everything with HTTP 400 and reuses statusCode "404", so neither field
 * identifies a missing object. Even `NoSuchKey` is ambiguous for a user-scoped request (it is also
 * returned for objects the caller cannot read), so it is only a CANDIDATE: the caller must confirm
 * absence with a service-role existence check before treating the upload as missing.
 * Everything else is retryable and never leads to deletion.
 */

export type StorageErrorClass = "not_found_candidate" | "retryable";

export function classifyStorageError(error: unknown): StorageErrorClass {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "NoSuchKey") {
    return "not_found_candidate";
  }
  return "retryable";
}

/** Fixed, loggable description (never the message, which can echo paths). */
export function storageErrorTag(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as { name?: unknown; status?: unknown; code?: unknown };
  return `${typeof e.name === "string" ? e.name : "Error"}:${typeof e.status === "number" ? e.status : "-"}:${typeof e.code === "string" ? e.code.slice(0, 40) : "-"}`;
}
