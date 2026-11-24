import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyStorageError, storageErrorTag } from "../storage-errors.ts";

/** Shapes copied from real responses of the hosted dev project (TASK 005.4.1 probe). */
const apiError = (status: number, statusCode: string, code: string, message: string) =>
  Object.assign(new Error(message), { name: "StorageApiError", status, statusCode, code });

describe("classifyStorageError", () => {
  test("NoSuchKey is only a not-found CANDIDATE (also returned for unreadable objects)", () => {
    assert.equal(classifyStorageError(apiError(400, "404", "NoSuchKey", "Object not found")), "not_found_candidate");
  });

  test("statusCode 404 / HTTP 400 alone never means missing", () => {
    assert.equal(classifyStorageError(apiError(400, "404", "NoSuchBucket", "Bucket not found")), "retryable"); // invalid JWT
    assert.equal(classifyStorageError(apiError(400, "400", "InvalidKey", "Invalid key")), "retryable");
    assert.equal(classifyStorageError(apiError(400, "400", "InvalidRequest", "Bad request")), "retryable");
    assert.equal(classifyStorageError({ status: 404, statusCode: "404" }), "retryable");
    assert.equal(classifyStorageError(apiError(500, "500", "InternalError", "boom")), "retryable");
  });

  test("network and unknown errors are retryable", () => {
    assert.equal(classifyStorageError(Object.assign(new Error("fetch failed"), { name: "StorageUnknownError" })), "retryable");
    assert.equal(classifyStorageError(null), "retryable");
    assert.equal(classifyStorageError("NoSuchKey"), "retryable");
  });

  test("log tag carries fixed fields only, never the message", () => {
    const tag = storageErrorTag(apiError(400, "404", "NoSuchKey", "Object not found: user/secret-path.pdf"));
    assert.equal(tag, "StorageApiError:400:NoSuchKey");
    assert.doesNotMatch(tag, /secret-path/);
  });
});
