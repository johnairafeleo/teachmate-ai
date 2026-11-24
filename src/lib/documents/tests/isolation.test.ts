import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ExtractionError } from "../errors.ts";
import { extractDocument } from "../extract.ts";
import { acquireExtractionSlot, extractDocumentIsolated, extractionSlotsInUse, hasMemoryForExtraction, MEMORY_LIMITS, MemoryPressureError, WORKER_LIMITS, type MemoryLimits } from "../isolated-extract.ts";
import { densePdfPage, documentXml, flateBombPdf, LESSON, makeDocx, makePdf, mutate, numberedPages, para, prng, rejectsWith } from "./fixtures.ts";

const FAULT = new URL("./fault-worker.ts", import.meta.url);
const MiB = 1024 * 1024;
const cmd = (text: string) => new TextEncoder().encode(text.padEnd(64, " "));
const fault = (text: string, options: Parameters<typeof extractDocumentIsolated>[2] = {}) =>
  extractDocumentIsolated(cmd(text), "pdf", { workerUrl: FAULT, deadlineMs: 2000, ...options });

/** Largest gap between 1 ms timer ticks while `run` is in flight = longest event-loop stall. */
async function maxStall<T>(run: () => Promise<T>): Promise<{ value: T | undefined; error: unknown; stallMs: number; elapsedMs: number }> {
  let last = performance.now();
  let stall = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 1);
  const started = performance.now();
  let value: T | undefined;
  let error: unknown;
  try {
    value = await run();
  } catch (e) {
    error = e;
  }
  const elapsedMs = performance.now() - started;
  await new Promise((r) => setTimeout(r, 5));
  clearInterval(ticker);
  return { value, error, stallMs: Math.round(stall), elapsedMs: Math.round(elapsedMs) };
}

/**
 * Stall caused by the extraction itself: compare against an idle control window of the same
 * length measured right before. `node --test` runs files in parallel processes, so CPU
 * contention from other suites delays timers even when this thread does nothing.
 */
async function stallBeyondControl<T>(run: () => Promise<T>) {
  const probe = await maxStall(() => new Promise((r) => setTimeout(r, 300)));
  const measured = await maxStall(run);
  const control = await maxStall(() => new Promise((r) => setTimeout(r, Math.max(300, measured.elapsedMs))));
  const baseline = Math.max(probe.stallMs, control.stallMs);
  return { ...measured, baselineMs: baseline, extraStallMs: Math.max(0, measured.stallMs - baseline) };
}

// No unhandled rejection or uncaught exception may reach the main thread during this suite.
const stray: unknown[] = [];
const onStray = (e: unknown) => stray.push(e);
before(() => {
  process.on("unhandledRejection", onStray);
  process.on("uncaughtException", onStray);
});
after(() => {
  process.off("unhandledRejection", onStray);
  process.off("uncaughtException", onStray);
  assert.deepEqual(stray, []);
  assert.equal(extractionSlotsInUse(), 0, "every slot released");
});

describe("isolated extraction: results match the in-thread engine", () => {
  test("PDF in a worker", async () => {
    const bytes = makePdf([["Grade 3 Science", LESSON], ["Parts of a plant."]]);
    assert.deepEqual(await extractDocumentIsolated(bytes, "pdf"), await extractDocument(bytes, "pdf"));
  });
  test("DOCX in a worker", async () => {
    const bytes = makeDocx({ body: para("Lesson") + para(LESSON) });
    assert.deepEqual(await extractDocumentIsolated(bytes, "docx"), await extractDocument(bytes, "docx"));
  });
  test("limits still apply: > 50 pages, character cap, ZIP bomb, malformed and encrypted input", async () => {
    const many = await extractDocumentIsolated(makePdf(numberedPages(60)), "pdf");
    assert.equal(many.page_count, 50);
    assert.equal(many.is_truncated, true);
    const paragraphs = Array.from({ length: 2500 }, (_, i) => para(`Paragraph ${i} about the water cycle and weather patterns.`)).join("");
    const long = await extractDocumentIsolated(makeDocx({ body: paragraphs }), "docx");
    assert.ok(long.text.length <= 100_000 && long.is_truncated);
    const bomb = makeDocx({ extra: [{ name: "word/media/bomb.bin", data: new Uint8Array(30 * MiB) }] });
    assert.equal((await rejectsWith(extractDocumentIsolated(bomb, "docx"), "LIMITS_EXCEEDED")).reason, "zip_ratio");
    await rejectsWith(extractDocumentIsolated(new TextEncoder().encode("%PDF-1.7\n" + "garbage ".repeat(100)), "pdf"), "MALFORMED_DOCUMENT");
    await rejectsWith(extractDocumentIsolated(makeDocx({ document: "<html/>" }), "docx"), "MALFORMED_DOCUMENT");
    await rejectsWith(extractDocumentIsolated(makePdf([[LESSON]], { encrypt: true }), "pdf"), "ENCRYPTED_DOCUMENT");
  });
  test("cheap checks happen in the parent (no worker started)", async () => {
    await rejectsWith(extractDocumentIsolated(new Uint8Array(0), "pdf"), "EMPTY_FILE");
    await rejectsWith(extractDocumentIsolated(new Uint8Array(10 * MiB + 1), "pdf"), "FILE_TOO_LARGE");
    await rejectsWith(extractDocumentIsolated(new Uint8Array(5), "exe"), "UNSUPPORTED_TYPE");
  });
});

describe("CPU isolation", () => {
  test("a pathological PDF page no longer blocks the event loop; the hard deadline terminates it", async () => {
    const dense = densePdfPage(8); // one ~1.9 s uninterruptible PDF.js step (measured in TASK 005.3)
    await new Promise((r) => setTimeout(r, 100)); // let fixture garbage settle before measuring
    const run = await stallBeyondControl(() => extractDocumentIsolated(dense, "pdf", { deadlineMs: 200 }));
    assert.ok(run.error instanceof ExtractionError && run.error.code === "TIMEOUT", String(run.error));
    // Whichever fires first under load: the parent's hard kill, or the worker's own cooperative check.
    assert.ok(["worker_timeout", "deadline"].includes(String((run.error as ExtractionError).reason)), String((run.error as ExtractionError).reason));
    assert.ok(run.elapsedMs < 200 + WORKER_LIMITS.hardTimeoutGraceMs + 1500, `took ${run.elapsedMs} ms`);
    assert.ok(run.extraStallMs < 150, `extraction added ${run.extraStallMs} ms of stall (raw ${run.stallMs}, idle baseline ${run.baselineMs})`);
    console.log(`  dense PDF, 200 ms deadline: TIMEOUT after ${run.elapsedMs} ms; main-thread stall ${run.stallMs} ms (idle baseline ${run.baselineMs} ms)`);
  });

  test("an infinite synchronous loop is terminated and stops using CPU", async () => {
    const run = await maxStall(() => fault("HANG", { deadlineMs: 100 }));
    assert.ok(run.error instanceof ExtractionError && run.error.code === "TIMEOUT" && run.error.reason === "worker_timeout");
    assert.ok(run.stallMs < 150, `stall ${run.stallMs} ms`);
    // After termination the process must be idle: measure CPU over the next 500 ms.
    const before = process.cpuUsage();
    await new Promise((r) => setTimeout(r, 500));
    const used = process.cpuUsage(before);
    const cpuMs = (used.user + used.system) / 1000;
    assert.ok(cpuMs < 200, `process used ${cpuMs.toFixed(0)} ms CPU in 500 ms after termination`);
    console.log(`  infinite loop: TIMEOUT after ${run.elapsedMs} ms; CPU in the 500 ms after: ${cpuMs.toFixed(0)} ms`);
  });

  test("large DOCX (18 MiB document.xml): main thread stays responsive", async () => {
    const bytes = (() => {
      let xml = "";
      for (let i = 0; xml.length < 18 * MiB; i++) xml += `<w:p><w:r><w:t>Sentence ${i} ${(i * 7919) % 10007} about plants.</w:t></w:r></w:p>`;
      return makeDocx({ document: documentXml(xml) });
    })();
    await new Promise((r) => setTimeout(r, 100)); // let the 18 MiB fixture string be collected first
    const run = await stallBeyondControl(() => extractDocumentIsolated(bytes, "docx"));
    assert.equal(run.error, undefined, String(run.error));
    assert.ok(run.extraStallMs < 150, `extraction added ${run.extraStallMs} ms of stall (raw ${run.stallMs}, idle baseline ${run.baselineMs})`);
    console.log(`  18 MiB document.xml: ${run.elapsedMs} ms in the worker; main-thread stall ${run.stallMs} ms (idle baseline ${run.baselineMs} ms)`);
  });
});

describe("worker failures map to fixed errors", () => {
  test("crash → INTERNAL_ERROR (worker_crash)", async () => {
    assert.equal((await rejectsWith(fault("CRASH"), "INTERNAL_ERROR")).reason, "worker_crash");
  });
  test("exit without a reply → INTERNAL_ERROR (worker_exit)", async () => {
    assert.equal((await rejectsWith(fault("EXIT"), "INTERNAL_ERROR")).reason, "worker_exit");
  });
  test("every invalid reply shape → INTERNAL_ERROR (worker_protocol)", async () => {
    for (let variant = 0; variant <= 6; variant++) {
      assert.equal((await rejectsWith(fault(`INVALID:${variant}`), "INTERNAL_ERROR")).reason, "worker_protocol", `variant ${variant}`);
    }
  });
  test("out of memory → LIMITS_EXCEEDED (worker_memory), main thread unaffected", async () => {
    const error = await rejectsWith(fault("OOM", { deadlineMs: 15_000, resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 } }), "LIMITS_EXCEEDED");
    assert.equal(error.reason, "worker_memory");
  });
  test("worker that cannot start → INTERNAL_ERROR (worker_crash/exit/start)", async () => {
    const error = await rejectsWith(extractDocumentIsolated(cmd("x"), "pdf", { workerUrl: new URL("./does-not-exist.ts", import.meta.url) }), "INTERNAL_ERROR");
    assert.ok(["worker_start", "worker_crash", "worker_exit"].includes(String(error.reason)), String(error.reason));
  });
  test("parent cancellation (AbortSignal) terminates the worker", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const error = await rejectsWith(fault("HANG", { deadlineMs: 10_000, signal: controller.signal }), "TIMEOUT");
    assert.equal(error.reason, "aborted");
    assert.ok(Date.now() - started < 2000);
  });
});

describe("resources", () => {
  test("no secrets or privileged clients reach the worker", async () => {
    process.env.SUPABASE_SECRET_KEY_TEST_CANARY = "canary-value";
    try {
      const result = await fault("PROBE");
      const seen = JSON.parse(result.text) as { envKeys: string[]; requestKeys: string[]; bytesIsArrayBuffer: boolean };
      assert.deepEqual(seen.envKeys, ["NODE_ENV"], "only NODE_ENV");
      assert.deepEqual(seen.requestKeys, ["bytes", "deadlineMs", "kind", "mimeType"], "only plain parameters");
      assert.equal(seen.bytesIsArrayBuffer, true);
    } finally {
      delete process.env.SUPABASE_SECRET_KEY_TEST_CANARY;
    }
  });

  test("transfer hands the buffer over (no copy); default keeps the caller's bytes", async () => {
    const kept = makePdf([[LESSON]]);
    await extractDocumentIsolated(kept, "pdf");
    assert.ok(kept.byteLength > 0, "copied by default");
    const moved = new Uint8Array(makePdf([[LESSON]]));
    await extractDocumentIsolated(moved, "pdf", { transfer: true });
    assert.equal(moved.byteLength, 0, "transferred: the caller's view is detached");
  });

  test("concurrency is bounded per process; queued work completes", async () => {
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, extractionSlotsInUse())), 2);
    const results = await Promise.all(Array.from({ length: 6 }, () => fault("SLOW:150", { deadlineMs: 5000 })));
    clearInterval(sampler);
    assert.equal(results.length, 6);
    assert.ok(results.every((r) => r.text === "slow"));
    assert.equal(WORKER_LIMITS.maxConcurrentWorkers, 1, "one worker per process (TASK 005.7.2)");
    assert.equal(peak, WORKER_LIMITS.maxConcurrentWorkers, `peak ${peak}`);
    assert.equal(extractionSlotsInUse(), 0);
  });

  test("saturated: a slot that never frees → null / TIMEOUT (worker_busy) without starting a worker", async () => {
    const held = await Promise.all(Array.from({ length: WORKER_LIMITS.maxConcurrentWorkers }, () => acquireExtractionSlot(0)));
    try {
      assert.ok(held.every(Boolean));
      assert.equal(await acquireExtractionSlot(50), null);
      assert.equal((await rejectsWith(extractDocumentIsolated(makePdf([[LESSON]]), "pdf", { deadlineMs: 100 }), "TIMEOUT")).reason, "worker_busy");
    } finally {
      held.forEach((slot) => slot?.release());
    }
  });

  test("30 sequential workers: no leak of threads, slots or memory", async () => {
    const pdf = makePdf([[LESSON]]);
    global.gc?.();
    const before = process.memoryUsage().rss;
    const started = performance.now();
    for (let i = 0; i < 30; i++) await extractDocumentIsolated(pdf, "pdf");
    const perWorkerMs = (performance.now() - started) / 30;
    const growth = (process.memoryUsage().rss - before) / MiB;
    assert.equal(extractionSlotsInUse(), 0);
    assert.ok(growth < 150, `rss grew ${growth.toFixed(0)} MiB`);
    console.log(`  30 sequential workers: ${perWorkerMs.toFixed(0)} ms per extraction incl. worker start, rss +${growth.toFixed(0)} MiB`);
  });

  test("PDF.js internal unhandled rejections stay inside the worker (300 fuzzed PDFs)", async () => {
    const seed = makePdf([["Fuzz seed", LESSON], ["Second page text for fuzzing."]]);
    const random = prng(1);
    const codes: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      try {
        await extractDocumentIsolated(mutate(seed, random), "pdf", { deadlineMs: 3000 });
        codes.ok = (codes.ok ?? 0) + 1;
      } catch (error) {
        assert.ok(error instanceof ExtractionError, String(error));
        codes[error.code] = (codes[error.code] ?? 0) + 1;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(stray, [], "nothing leaked to the main thread");
    console.log(`  fuzz pdf (isolated): ${JSON.stringify(codes)}; main-thread unhandled rejections: ${stray.length}`);
  });
});

/** Peak process RSS growth while `run` is in flight (main-thread sampler; workers share the process). */
async function peakGrowth<T>(run: () => Promise<T>) {
  await new Promise((r) => setTimeout(r, 200)); // let earlier garbage settle
  const start = process.memoryUsage.rss();
  let peak = start;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 5);
  const started = performance.now();
  let error: unknown;
  let value: T | undefined;
  try {
    value = await run();
  } catch (e) {
    error = e;
  }
  clearInterval(sampler);
  return { value, error, startMiB: Math.round(start / MiB), growthMiB: Math.round((peak - start) / MiB), elapsedMs: Math.round(performance.now() - started) };
}

/** Fake RSS reader: `before` bytes until `afterMs` have passed, then `after`. */
function steppedRss(before: number, after: number, afterMs: number): () => number {
  const t0 = Date.now();
  return () => (Date.now() - t0 >= afterMs ? after : before);
}

const limits = (overrides: Partial<MemoryLimits>): MemoryLimits => ({ ...MEMORY_LIMITS, ...overrides });

/** Expect a shared-pressure kill (the document is not blamed). */
async function rejectsShared(run: Promise<unknown>): Promise<MemoryPressureError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof MemoryPressureError, `expected MemoryPressureError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected MemoryPressureError, but it resolved");
}

describe("memory watchdog (process RSS; worker heap limits do not cover ArrayBuffers)", () => {
  test("selected limits leave headroom below Vercel Hobby's 2 GB", () => {
    assert.equal(MEMORY_LIMITS.absoluteRssBytes, 1280 * MiB);
    assert.equal(MEMORY_LIMITS.maxGrowthBytes, 512 * MiB);
    assert.equal(MEMORY_LIMITS.admissionRssBytes, MEMORY_LIMITS.absoluteRssBytes - MEMORY_LIMITS.maxGrowthBytes);
    assert.ok(MEMORY_LIMITS.absoluteRssBytes <= 2048 * MiB - 512 * MiB, "≥ 512 MiB of headroom for overshoot");
  });

  test("control: a compressed PDF bomb is NOT stopped by worker resourceLimits", async () => {
    // Watchdog effectively off: only V8 heap limits apply.
    const off = limits({ admissionRssBytes: Number.MAX_SAFE_INTEGER, absoluteRssBytes: Number.MAX_SAFE_INTEGER, maxGrowthBytes: Number.MAX_SAFE_INTEGER });
    const bomb = flateBombPdf(300);
    const run = await peakGrowth(() => extractDocumentIsolated(bomb, "pdf", { memory: off, deadlineMs: 30_000 }));
    assert.equal(run.error, undefined, String(run.error));
    assert.ok(run.growthMiB > 256, `grew ${run.growthMiB} MiB`);
    console.log(`  300 MiB-decoding PDF (${(bomb.length / 1024).toFixed(0)} KiB file), watchdog off: completed, rss +${run.growthMiB} MiB in ${run.elapsedMs} ms`);
  });

  test("default limits: a ~1 MiB PDF that inflates to 1 GiB → LIMITS_EXCEEDED, worker terminated, slot released", async () => {
    const bomb = flateBombPdf(1024);
    const run = await peakGrowth(() => extractDocumentIsolated(bomb, "pdf", { deadlineMs: 30_000 }));
    assert.ok(run.error instanceof ExtractionError && run.error.code === "LIMITS_EXCEEDED", String(run.error));
    assert.ok(["memory_growth", "process_memory"].includes(String(run.error.reason)), String(run.error.reason));
    assert.ok(run.growthMiB < 512 + 384, `peak growth ${run.growthMiB} MiB`);
    assert.ok(run.elapsedMs < 15_000, `took ${run.elapsedMs} ms`);
    assert.equal(extractionSlotsInUse(), 0);
    await new Promise((r) => setTimeout(r, 300));
    const after = Math.round(process.memoryUsage.rss() / MiB);
    console.log(`  1 GiB-decoding PDF (${(bomb.length / MiB).toFixed(2)} MiB file): ${run.error.reason} after ${run.elapsedMs} ms; rss ${run.startMiB} → peak +${run.growthMiB} MiB, ${after} MiB 300 ms after termination`);
  });

  test("growth ceiling: a smaller cap stops a smaller bomb (reason memory_growth; attribution scaled down with it)", async () => {
    const bomb = flateBombPdf(256);
    const run = await peakGrowth(() => extractDocumentIsolated(bomb, "pdf", { memory: limits({ maxGrowthBytes: 64 * MiB, documentAttributionBytes: 32 * MiB }), deadlineMs: 30_000 }));
    assert.ok(run.error instanceof ExtractionError && run.error.code === "LIMITS_EXCEEDED" && run.error.reason === "memory_growth", String(run.error));
    assert.ok(run.growthMiB < 64 + 256, `peak growth ${run.growthMiB} MiB`);
    console.log(`  64 MiB growth cap, 256 MiB-decoding PDF: memory_growth after ${run.elapsedMs} ms (peak +${run.growthMiB} MiB)`);
  });

  test("absolute ceiling: RSS above it terminates a busy worker, whatever the growth", async () => {
    // Growth cap disabled, so only the absolute ceiling can fire. The worker busy-waits 10 s and
    // allocates almost nothing itself, so the kill is attributed to SHARED pressure.
    const memory = limits({ maxGrowthBytes: Number.MAX_SAFE_INTEGER, readRss: steppedRss(600 * MiB, 1300 * MiB, 150) });
    const started = Date.now();
    const error = await rejectsShared(fault("SLOW:10000", { deadlineMs: 15_000, memory }));
    assert.equal(error.trigger, "process_memory");
    assert.equal(error.attribution, "measured");
    assert.ok(error.workerPeakBytes !== null && error.workerPeakBytes < 64 * MiB, String(error.workerPeakBytes));
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
    // Terminated, not left running: the process is idle afterwards.
    const before = process.cpuUsage();
    await new Promise((r) => setTimeout(r, 500));
    const used = process.cpuUsage(before);
    assert.ok((used.user + used.system) / 1000 < 200, "worker stopped using CPU");
    assert.equal(extractionSlotsInUse(), 0);
  });

  test("the baseline is the real current RSS, not zero: high but steady RSS below the ceilings is fine", async () => {
    // 1 GiB baseline (admission raised for the test) with growth of 100 MiB < 512 MiB cap.
    const memory = limits({ admissionRssBytes: 1100 * MiB, absoluteRssBytes: 1280 * MiB, readRss: steppedRss(1024 * MiB, 1124 * MiB, 50) });
    const result = await fault("SLOW:300", { deadlineMs: 5_000, memory });
    assert.equal(result.text, "slow");
    // …and the same growth from a baseline near the ceiling trips the absolute limit.
    const near = limits({ admissionRssBytes: 1250 * MiB, readRss: steppedRss(1200 * MiB, 1300 * MiB, 50) });
    assert.equal((await rejectsShared(fault("SLOW:2000", { deadlineMs: 5_000, memory: near }))).trigger, "process_memory");
  });

  test("admission: RSS already above the admission ceiling → no worker is started (TIMEOUT memory_busy)", async () => {
    const memory = limits({ readRss: () => 900 * MiB });
    assert.deepEqual(hasMemoryForExtraction(memory), { ok: false, rssBytes: 900 * MiB });
    assert.equal(hasMemoryForExtraction(limits({ readRss: () => 700 * MiB })).ok, true);
    // A worker URL that cannot load: had a worker been started, this would be INTERNAL_ERROR.
    const error = await rejectsWith(extractDocumentIsolated(cmd("x"), "pdf", { memory, workerUrl: new URL("./does-not-exist.ts", import.meta.url) }), "TIMEOUT");
    assert.equal(error.reason, "memory_busy");
    assert.equal(extractionSlotsInUse(), 0);
  });

  test("admissionChecked (caller checked before its claim): no second admission check, the watchdog still applies", async () => {
    // Above admission (768) but below the absolute ceiling: a caller-checked extraction runs…
    const high = limits({ readRss: () => 900 * MiB });
    assert.equal((await fault("SLOW:50", { memory: high, admissionChecked: true })).text, "slow");
    // …and is still terminated if RSS then passes the absolute ceiling.
    const rising = limits({ readRss: steppedRss(900 * MiB, 1300 * MiB, 100) });
    assert.equal((await rejectsShared(fault("SLOW:5000", { memory: rising, admissionChecked: true }))).trigger, "process_memory");
    // Without the flag the same RSS is refused before any worker starts.
    assert.equal((await rejectsWith(fault("SLOW:50", { memory: high }), "TIMEOUT")).reason, "memory_busy");
    assert.equal(extractionSlotsInUse(), 0);
  });

  test("ordinary PDF and DOCX still succeed under the default limits", async () => {
    // Fixtures are built before measuring, so only the extraction counts.
    const small = makePdf([["Grade 3 Science", LESSON], ["Parts of a plant."]]);
    const densePdf = densePdfPage(8);
    const pdf = await peakGrowth(() => extractDocumentIsolated(small, "pdf"));
    assert.equal(pdf.error, undefined, String(pdf.error));
    const dense = await peakGrowth(() => extractDocumentIsolated(densePdf, "pdf", { deadlineMs: 30_000 }));
    assert.equal(dense.error, undefined, String(dense.error));
    let xml = "";
    for (let i = 0; xml.length < 18 * MiB; i++) xml += `<w:p><w:r><w:t>Sentence ${i} ${(i * 7919) % 10007} about plants.</w:t></w:r></w:p>`;
    const docxBytes = makeDocx({ document: documentXml(xml) });
    xml = "";
    const docx = await peakGrowth(() => extractDocumentIsolated(docxBytes, "docx"));
    assert.equal(docx.error, undefined, String(docx.error));
    console.log(`  ordinary documents, default limits: small PDF +${pdf.growthMiB} MiB; dense 8 MiB PDF +${dense.growthMiB} MiB (${dense.elapsedMs} ms); 18 MiB document.xml +${docx.growthMiB} MiB (${docx.elapsedMs} ms)`);
  });

  test("no timers, workers or slots leak across success, timeout, watchdog kill, crash and admission refusal", async () => {
    const resources = () => process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap").sort();
    await new Promise((r) => setTimeout(r, 100));
    const before = resources();
    await extractDocumentIsolated(makePdf([[LESSON]]), "pdf");
    await rejectsWith(fault("HANG", { deadlineMs: 100 }), "TIMEOUT");
    await rejectsShared(fault("SLOW:5000", { memory: limits({ readRss: steppedRss(100 * MiB, 2000 * MiB, 50) }) }));
    // 400 ms: the worker must be online and have reported a sample before the (fake) kill.
    await rejectsWith(fault("SLOW:5000", { memory: limits({ readRss: steppedRss(100 * MiB, 2000 * MiB, 400), readWorkerBytes: async () => 300 * MiB }) }), "LIMITS_EXCEEDED");
    await rejectsShared(fault("SLOW:5000", { memory: limits({ readRss: steppedRss(100 * MiB, 2000 * MiB, 50), readWorkerBytes: () => Promise.reject(new Error("stats down")) }) }));
    await rejectsWith(fault("CRASH"), "INTERNAL_ERROR");
    await rejectsWith(fault("x", { memory: limits({ readRss: () => 2000 * MiB }) }), "TIMEOUT");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(resources(), before);
    assert.equal(extractionSlotsInUse(), 0);
  });
});

describe("memory attribution (worker.getHeapStatistics: used_heap_size + external_memory)", () => {
  test("the real worker exposes its own memory while parsing synchronously (bomb: ≥ 256 MiB before the kill → LIMITS_EXCEEDED)", async () => {
    // Default limits: the 512 MiB growth limit fires; the worker's own stats passed 256 MiB first.
    const error = await rejectsWith(extractDocumentIsolated(flateBombPdf(1024), "pdf", { deadlineMs: 30_000 }), "LIMITS_EXCEEDED");
    assert.ok(["memory_growth", "process_memory"].includes(String(error.reason)), String(error.reason));
  });

  test("bomb + concurrent parent growth: genuinely ambiguous → either outcome is bounded (known limitation)", async () => {
    // The parent adds 256 MiB within ~0.3 s while a bomb runs. If the 512 MiB growth limit trips
    // before the bomb's own memory reaches 256 MiB, the kill is attributed to SHARED pressure and
    // the document is released; the service's cap (2 releases) then makes it permanent. Either way
    // the worker is terminated and nothing else is affected.
    const keep: Uint8Array[] = [];
    const timer = setInterval(() => { if (keep.length < 16) keep.push(new Uint8Array(16 * MiB).fill(1)); }, 20);
    try {
      const error = await extractDocumentIsolated(flateBombPdf(1024), "pdf", { deadlineMs: 30_000 }).then(() => null, (e: unknown) => e);
      const documentFault = error instanceof ExtractionError && error.code === "LIMITS_EXCEEDED";
      assert.ok(documentFault || error instanceof MemoryPressureError, String(error));
      console.log(`  bomb + parent +256 MiB: ${documentFault ? "LIMITS_EXCEEDED (document)" : `shared pressure (worker peak ${Math.round(((error as MemoryPressureError).workerPeakBytes ?? 0) / MiB)} MiB) → bounded by the release cap`}`);
      assert.equal(extractionSlotsInUse(), 0);
    } finally {
      clearInterval(timer);
      keep.length = 0;
    }
  });

  test("parent memory is NOT attributed to the worker: unrelated parent growth → shared pressure", async () => {
    // The worker busy-waits (owns ~10–30 MiB); the PARENT keeps allocating real memory (up to
    // 640 MiB, so garbage from earlier tests being collected meanwhile can't hide it) and the
    // growth limit is lowered to 128 MiB, so the real RSS watchdog fires on the parent's growth.
    global.gc?.();
    const keep: Uint8Array[] = [];
    const timer = setInterval(() => { if (keep.length < 40) keep.push(new Uint8Array(16 * MiB).fill(1)); }, 20);
    try {
      const error = await rejectsShared(fault("SLOW:8000", { deadlineMs: 15_000, memory: limits({ maxGrowthBytes: 128 * MiB }) }));
      assert.equal(error.trigger, "memory_growth");
      assert.equal(error.attribution, "measured");
      assert.ok(error.workerPeakBytes !== null && error.workerPeakBytes < 64 * MiB, `worker peak ${Math.round((error.workerPeakBytes ?? 0) / MiB)} MiB`);
      console.log(`  parent +${keep.length * 16} MiB, idle worker: shared pressure; worker peak ${Math.round((error.workerPeakBytes ?? 0) / MiB)} MiB`);
    } finally {
      clearInterval(timer);
      keep.length = 0;
    }
  });

  test("threshold: worker peak ≥ documentAttributionBytes → LIMITS_EXCEEDED; below → MemoryPressureError (measured)", async () => {
    const kill = steppedRss(100 * MiB, 2000 * MiB, 120);
    const doc = limits({ readRss: kill, readWorkerBytes: async () => 256 * MiB });
    assert.equal((await rejectsWith(fault("SLOW:5000", { memory: doc }), "LIMITS_EXCEEDED")).reason, "process_memory");
    const shared = await rejectsShared(fault("SLOW:5000", { memory: limits({ readRss: steppedRss(100 * MiB, 2000 * MiB, 120), readWorkerBytes: async () => 256 * MiB - 1 }) }));
    assert.equal(shared.attribution, "measured");
    assert.equal(shared.workerPeakBytes, 256 * MiB - 1);
  });

  test("the PEAK counts: a worker that reached 300 MiB earlier and dropped is still blamed", async () => {
    let calls = 0;
    const readWorkerBytes = async () => (calls++ === 2 ? 300 * MiB : 20 * MiB);
    await rejectsWith(fault("SLOW:5000", { memory: limits({ readRss: steppedRss(100 * MiB, 2000 * MiB, 200), readWorkerBytes }) }), "LIMITS_EXCEEDED");
  });

  test("statistics unavailable (every call rejects, or never answers) → shared pressure, attribution 'unavailable'; watchdog unaffected", async () => {
    const started = Date.now();
    const rejecting = await rejectsShared(fault("SLOW:5000", { memory: limits({ readRss: steppedRss(100 * MiB, 2000 * MiB, 100), readWorkerBytes: () => Promise.reject(new Error("down")) }) }));
    assert.deepEqual([rejecting.attribution, rejecting.workerPeakBytes], ["unavailable", null]);
    const hanging = await rejectsShared(fault("SLOW:5000", { memory: limits({ readRss: steppedRss(100 * MiB, 2000 * MiB, 100), readWorkerBytes: () => new Promise<number>(() => {}) }) }));
    assert.deepEqual([hanging.attribution, hanging.workerPeakBytes], ["unavailable", null]);
    const throwing = await rejectsShared(fault("SLOW:5000", { memory: limits({ readRss: steppedRss(100 * MiB, 2000 * MiB, 100), readWorkerBytes: () => { throw new Error("sync"); } }) }));
    assert.equal(throwing.attribution, "unavailable");
    assert.ok(Date.now() - started < 3_000, `watchdog still fired promptly (${Date.now() - started} ms for three runs)`);
    assert.equal(extractionSlotsInUse(), 0);
  });

  test("worker terminated before 'online' → no stats polling starts, no stray timers", async () => {
    const resources = () => process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap").sort();
    await new Promise((r) => setTimeout(r, 100));
    const before = resources();
    let statsCalls = 0;
    // An already-aborted signal terminates the worker synchronously, before it can come online.
    const error = await rejectsWith(fault("SLOW:1000", { signal: AbortSignal.abort(), memory: limits({ readWorkerBytes: async () => (statsCalls++, 0) }) }), "TIMEOUT");
    assert.equal(error.reason, "aborted");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(statsCalls, 0, "polling never started");
    assert.deepEqual(resources(), before);
  });

  test("ordinary documents stay far below the attribution threshold (no false blame)", async () => {
    const peaks: Record<string, number> = {};
    for (const [label, bytes, kind] of [["small PDF", makePdf([["Grade 3 Science", LESSON]]), "pdf"], ["dense 8 MiB PDF", densePdfPage(8), "pdf"]] as const) {
      let peak = 0;
      const memory = limits({
        readWorkerBytes: async (worker) => {
          const stats = await (worker as unknown as { getHeapStatistics(): Promise<{ used_heap_size: number; external_memory: number }> }).getHeapStatistics();
          peak = Math.max(peak, stats.used_heap_size + stats.external_memory);
          return stats.used_heap_size + stats.external_memory;
        },
      });
      await extractDocumentIsolated(bytes, kind, { memory, deadlineMs: 30_000 });
      peaks[label] = Math.round(peak / MiB);
      assert.ok(peak < MEMORY_LIMITS.documentAttributionBytes, `${label}: ${peaks[label]} MiB`);
    }
    console.log(`  worker peak (used_heap + external): ${JSON.stringify(peaks)} MiB; threshold ${MEMORY_LIMITS.documentAttributionBytes / MiB} MiB`);
  });
});
