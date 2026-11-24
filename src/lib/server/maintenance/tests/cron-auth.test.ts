import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";

import { isCronSecretConfigured, MIN_CRON_SECRET_LENGTH, verifyCronAuthorization } from "../cron-auth.ts";

const SECRET = randomBytes(32).toString("base64url"); // 43 characters

describe("verifyCronAuthorization", () => {
  test("valid: exactly `Bearer <secret>`", () => {
    assert.equal(verifyCronAuthorization(`Bearer ${SECRET}`, SECRET), true);
  });

  test("missing CRON_SECRET (or too short) rejects everything, even a matching header", () => {
    assert.equal(verifyCronAuthorization("Bearer ", undefined), false);
    assert.equal(verifyCronAuthorization("Bearer \u0000unconfigured", undefined), false);
    assert.equal(verifyCronAuthorization("Bearer ", ""), false);
    const short = "x".repeat(MIN_CRON_SECRET_LENGTH - 1);
    assert.equal(verifyCronAuthorization(`Bearer ${short}`, short), false);
    assert.equal(isCronSecretConfigured(short), false);
    assert.equal(isCronSecretConfigured("x".repeat(MIN_CRON_SECRET_LENGTH)), true);
  });

  test("missing or malformed header", () => {
    for (const header of [null, undefined, "", "Bearer", "Bearer ", SECRET, `bearer ${SECRET}`, `Basic ${SECRET}`, `Bearer  ${SECRET}`, ` Bearer ${SECRET}`, `Bearer ${SECRET} `]) {
      assert.equal(verifyCronAuthorization(header, SECRET), false, JSON.stringify(header));
    }
  });

  test("invalid secrets: prefixes, extensions, one-character changes, other lengths", () => {
    const flipped = SECRET.slice(0, -1) + (SECRET.endsWith("A") ? "B" : "A");
    for (const guess of [SECRET.slice(0, -1), `${SECRET}x`, flipped, SECRET.slice(1), "x".repeat(200), SECRET.toUpperCase()]) {
      assert.equal(verifyCronAuthorization(`Bearer ${guess}`, SECRET), false);
    }
  });

  test("constant-time shape: comparison work does not depend on how much of the guess matches", () => {
    // timingSafeEqual is only ever given two SHA-256 digests (32 bytes each), so a near miss and
    // a far miss take the same path. Coarse sanity check that neither is meaningfully faster.
    const nearMiss = `Bearer ${SECRET.slice(0, -1)}#`;
    const farMiss = `Bearer ${"#".repeat(SECRET.length)}`;
    const time = (header: string) => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < 5_000; i++) verifyCronAuthorization(header, SECRET);
      return Number(process.hrtime.bigint() - start);
    };
    time(nearMiss); // warm up
    time(farMiss);
    // Alternate the two measurements and compare medians, so CPU contention from other test
    // processes (node --test runs files in parallel) can't decide the result on its own.
    const near: number[] = [];
    const far: number[] = [];
    for (let round = 0; round < 7; round++) {
      near.push(time(nearMiss));
      far.push(time(farMiss));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const ratio = Math.max(median(near), median(far)) / Math.min(median(near), median(far));
    assert.ok(ratio < 1.5, `near/far median timing ratio ${ratio.toFixed(2)}`);
  });
});
