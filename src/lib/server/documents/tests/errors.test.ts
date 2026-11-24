import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isDocumentErrorCode, safeError, storedErrorToSafe } from "../errors.ts";

describe("memory-pressure error codes (TASK 005.7.6)", () => {
  test("SERVER_BUSY is retryable and says the upload is safe", () => {
    const busy = safeError("SERVER_BUSY");
    assert.equal(busy.retryable, true);
    assert.match(busy.message, /upload is safe/);
  });

  test("SERVER_CAPACITY is a stored, permanent code with its own message", () => {
    assert.equal(isDocumentErrorCode("SERVER_CAPACITY"), true);
    const stored = storedErrorToSafe("SERVER_CAPACITY");
    assert.equal(stored.code, "SERVER_CAPACITY");
    assert.equal(stored.retryable, false);
    assert.match(stored.message, /servers stayed too busy after several attempts/);
  });

  test("unknown stored codes still map to the generic error", () => {
    assert.equal(storedErrorToSafe("SOMETHING_ELSE").code, "INTERNAL_ERROR");
  });
});
