import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ExtractionError } from "../errors.ts";
import { extractDocument } from "../extract.ts";
import { densePdfPage, documentXml, FUZZ_ALLOWED_CODES, LESSON, latin1Bytes, makeDocx, makePdf, mutate, numberedPages, para, prng, rejectsWith } from "./fixtures.ts";

const MiB = 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Any unhandled rejection or uncaught exception during this suite fails it.
const stray: unknown[] = [];
const onStray = (error: unknown) => stray.push(error);
before(() => {
  process.on("unhandledRejection", onStray);
  process.on("uncaughtException", onStray);
});
after(() => {
  process.off("unhandledRejection", onStray);
  process.off("uncaughtException", onStray);
  assert.deepEqual(stray, [], "no unhandled rejections or uncaught exceptions");
});

describe("spoofed types and MIME types", () => {
  const pdf = makePdf([[LESSON]]);
  const docx = makeDocx();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(100)]);
  const html = latin1Bytes(`<!doctype html><html><body>${LESSON}</body></html>`);

  test("content decides, not the declared extension", async () => {
    await rejectsWith(extractDocument(pdf, "docx"), "TYPE_MISMATCH");
    await rejectsWith(extractDocument(docx, "pdf"), "TYPE_MISMATCH");
    await rejectsWith(extractDocument(png, "pdf"), "TYPE_MISMATCH");
    await rejectsWith(extractDocument(png, "docx"), "TYPE_MISMATCH");
    await rejectsWith(extractDocument(html, "pdf"), "TYPE_MISMATCH");
  });

  test("polyglots: PDF header + ZIP body as DOCX, ZIP + PDF tail as PDF", async () => {
    const pdfThenZip = new Uint8Array([...pdf, ...docx]);
    const zipThenPdf = new Uint8Array([...docx, ...pdf]);
    await rejectsWith(extractDocument(pdfThenZip, "docx"), "TYPE_MISMATCH");
    await rejectsWith(extractDocument(zipThenPdf, "pdf"), "TYPE_MISMATCH");
  });

  test("unsupported declared types", async () => {
    for (const kind of ["doc", "txt", "PDF", "pptx", "", "../pdf"]) {
      await rejectsWith(extractDocument(pdf, kind), "UNSUPPORTED_TYPE");
    }
  });

  test("incorrect MIME types are rejected; empty/absent MIME falls back to content checks", async () => {
    for (const mimeType of [DOCX_MIME, "text/html", "application/octet-stream", "application/x-msdownload"]) {
      await rejectsWith(extractDocument(pdf, "pdf", { mimeType }), "TYPE_MISMATCH");
    }
    await rejectsWith(extractDocument(docx, "docx", { mimeType: "application/pdf" }), "TYPE_MISMATCH");
    for (const mimeType of ["", null, undefined, " APPLICATION/PDF "]) {
      assert.match((await extractDocument(pdf, "pdf", { mimeType })).text, /Photosynthesis/);
    }
    assert.match((await extractDocument(docx, "docx", { mimeType: DOCX_MIME })).text, /Photosynthesis/);
  });

  test("input bounds: empty, over 10 MB, wrong input type", async () => {
    await rejectsWith(extractDocument(new Uint8Array(0), "pdf"), "EMPTY_FILE");
    await rejectsWith(extractDocument(new Uint8Array(10 * MiB + 1), "pdf"), "FILE_TOO_LARGE");
    await rejectsWith(extractDocument("not bytes" as unknown as Uint8Array, "pdf"), "UNSUPPORTED_TYPE");
  });

  test("error messages are fixed copy, never parser internals", async () => {
    const error = await rejectsWith(extractDocument(latin1Bytes("%PDF-1.7\n\u0000\u0001 broken"), "pdf"), "MALFORMED_DOCUMENT");
    assert.doesNotMatch(error.message, /pdf\.js|xref|Invalid PDF|stack|\\|\//i);
  });
});

describe("Unicode and control characters end to end (DOCX)", () => {
  test("normalised to NFC with unsafe characters removed and meaningful ones kept", async () => {
    const text = `Cafe\u0301 \u202Egnirts\u202C &#7;bell &#0;nul \u200Bzero ${"\u{E0049}\u{E0047}"}tags \u{1F469}\u200D\u{1F3EB} Ma\u00F1ana. ${LESSON}`;
    const result = await extractDocument(makeDocx({ body: `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>` }), "docx");
    assert.equal(result.text, `Caf\u00E9 gnirts bell nul zero tags \u{1F469}\u200D\u{1F3EB} Ma\u00F1ana. ${LESSON}`);
  });
});

describe("deadlines", () => {
  test("DOCX: deadline enforced inside decompression/parsing loops \u2192 TIMEOUT", async () => {
    const xml = documentXml(Array.from({ length: 60_000 }, (_, i) => para(`Sentence ${i} about plants and roots.`)).join(""));
    await rejectsWith(extractDocument(makeDocx({ document: xml }), "docx", { deadlineMs: 1 }), "TIMEOUT");
  });

  test("PDF: deadline enforced between awaited steps \u2192 TIMEOUT, and PDF.js is shut down", async () => {
    await rejectsWith(extractDocument(makePdf(numberedPages(50)), "pdf", { deadlineMs: 1 }), "TIMEOUT");
    // The engine still works afterwards (no leaked state from the destroyed task).
    assert.equal((await extractDocument(makePdf([[LESSON]]), "pdf")).page_count, 1);
  });

  test("PDF: a single blocking step that overruns the deadline is rejected, not accepted late", async () => {
    // One dense page = one uninterruptible PDF.js step longer than the deadline. The result
    // arrives late (no CPU isolation on this thread) but must be TIMEOUT, never "ok".
    const started = Date.now();
    await rejectsWith(extractDocument(densePdfPage(2), "pdf", { deadlineMs: 50 }), "TIMEOUT");
    console.log(`  dense-page deadline 50 ms → TIMEOUT after ${Date.now() - started} ms (overrun = no CPU isolation)`);
  });
});

describe("fuzzing: malformed input never escapes as an unexpected error", () => {
  test("docx: 300 seeded mutations (in-process; the suite fails on any unhandled rejection)", async () => {
    const seedBytes = makeDocx({ body: para("Fuzz seed") + para(LESSON) });
    const random = prng(2);
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      try {
        await extractDocument(mutate(seedBytes, random), "docx", { deadlineMs: 3000 });
        outcomes.ok = (outcomes.ok ?? 0) + 1;
      } catch (error) {
        assert.ok(error instanceof ExtractionError, `mutation ${i}: non-ExtractionError ${String(error)}`);
        assert.ok(FUZZ_ALLOWED_CODES.has(error.code), `mutation ${i}: ${error.code}`);
        outcomes[error.code] = (outcomes[error.code] ?? 0) + 1;
      }
    }
    console.log(`  fuzz docx: ${JSON.stringify(outcomes)}`);
  });

  test("pdf: 300 seeded mutations in a child process; no leaks from our code, PDF.js-internal leaks counted", () => {
    const runner = fileURLToPath(new URL("./fuzz-pdf-runner.ts", import.meta.url));
    const output = execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", runner, "300"], { encoding: "utf8", timeout: 120_000 });
    const report = JSON.parse(output.trim().split(/\r?\n/).pop() ?? "{}") as {
      iterations: number; outcomes: Record<string, number>; unexpectedErrors: string[]; ownLeaks: string[]; pdfjsLeaks: Record<string, number>;
    };
    console.log(`  fuzz pdf: ${JSON.stringify(report.outcomes)} pdfjs-internal unhandled rejections: ${JSON.stringify(report.pdfjsLeaks)}`);
    assert.equal(report.iterations, 300);
    assert.deepEqual(report.unexpectedErrors, [], "every failure is a fixed ExtractionError code");
    assert.deepEqual(report.ownLeaks, [], "no unhandled rejection originates outside PDF.js");
  });
});

describe("memory bounds and event-loop measurements", () => {
  const measure = async (label: string, run: () => Promise<unknown>) => {
    global.gc?.();
    // Longest event-loop stall = largest gap between 1 ms interval ticks (a histogram under-reports
    // a single long synchronous block). Peak RSS per scenario: see measure-runner.ts.
    let last = performance.now();
    let maxStall = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      maxStall = Math.max(maxStall, now - last);
      last = now;
    }, 1);
    const before = process.memoryUsage();
    const started = performance.now();
    let outcome = "ok";
    try {
      await run();
    } catch (error) {
      outcome = error instanceof ExtractionError ? error.code : "unexpected";
    }
    const elapsed = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearInterval(ticker);
    const afterUsage = process.memoryUsage();
    const growth = (afterUsage.heapUsed + afterUsage.arrayBuffers - before.heapUsed - before.arrayBuffers) / MiB;
    const stats = { label, outcome, ms: Math.round(elapsed), maxEventLoopStallMs: Math.round(maxStall), heapPlusBuffersGrowthMiB: Number(growth.toFixed(1)), rssMiB: Math.round(afterUsage.rss / MiB) };
    console.log(`  measure ${JSON.stringify(stats)}`);
    return stats;
  };

  test("ZIP bombs are rejected quickly without large allocations", async () => {
    const honestBomb = makeDocx({ extra: [{ name: "word/media/bomb.bin", data: new Uint8Array(30 * MiB) }] });
    const lyingBomb = makeDocx({ override: { "word/document.xml": { data: documentXml(`<w:p><w:r><w:t>${" ".repeat(15 * MiB)}</w:t></w:r></w:p>`), declaredSize: 100_000 } } });
    for (const [label, bytes] of [["honest 30 MiB bomb", honestBomb], ["lying-header 15 MiB bomb", lyingBomb]] as const) {
      const stats = await measure(label, () => extractDocument(bytes, "docx"));
      assert.equal(stats.outcome, "LIMITS_EXCEEDED");
      assert.ok(stats.ms < 1000, `${label} took ${stats.ms} ms`);
      assert.ok(stats.heapPlusBuffersGrowthMiB < 32, `${label} grew ${stats.heapPlusBuffersGrowthMiB} MiB`);
    }
  });

  test("largest accepted inputs stay within bounds (measurements for worker-isolation decision)", async () => {
    let xml = "";
    for (let i = 0; xml.length < 18 * MiB; i++) xml += `<w:p><w:r><w:t>Sentence ${i} ${(i * 7919) % 10007} about plants.</w:t></w:r></w:p>`;
    const bigDocx = makeDocx({ document: documentXml(xml) });
    const docxStats = await measure(`docx ${(bigDocx.length / MiB).toFixed(1)} MiB (18 MiB document.xml)`, () => extractDocument(bigDocx, "docx"));
    assert.equal(docxStats.outcome, "ok");

    const pageText = "Plants need sunlight, water, air and soil to grow and stay healthy. ".repeat(40);
    const bigPdf = makePdf(numberedPages(50, pageText));
    const pdfStats = await measure(`pdf ${(bigPdf.length / MiB).toFixed(2)} MiB, 50 pages`, () => extractDocument(bigPdf, "pdf"));
    assert.equal(pdfStats.outcome, "ok");

    const manyPages = makePdf(numberedPages(2000));
    const manyStats = await measure(`pdf ${(manyPages.length / MiB).toFixed(2)} MiB, 2000 pages`, () => extractDocument(manyPages, "pdf"));
    assert.equal(manyStats.outcome, "ok");
  });
});
