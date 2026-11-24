import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authorization for the scheduled maintenance endpoint.
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the project has a CRON_SECRET
 * environment variable. The ONLY accepted credential is that header with that secret:
 * no query parameters, no other headers, no IP or user-agent checks.
 *
 * - Fails closed: a missing or short (< 32 characters) CRON_SECRET rejects every request.
 * - Constant time: both sides are hashed with SHA-256 first, so timingSafeEqual always compares
 *   two 32-byte digests. Neither the length nor any prefix of a guess changes the work done.
 */
export const MIN_CRON_SECRET_LENGTH = 32;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function isCronSecretConfigured(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_CRON_SECRET_LENGTH;
}

export function verifyCronAuthorization(authorizationHeader: string | null | undefined, secret: string | undefined): boolean {
  // Always do the same hashing work, even when the request or the configuration is invalid.
  const expected = digest(`Bearer ${isCronSecretConfigured(secret) ? secret : "\u0000unconfigured"}`);
  const provided = digest(typeof authorizationHeader === "string" ? authorizationHeader : "");
  const matches = timingSafeEqual(expected, provided);
  return matches && isCronSecretConfigured(secret);
}
