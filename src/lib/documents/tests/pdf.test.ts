import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractDocument } from "../extract.ts";
import { LESSON, latin1Bytes, makePdf, numberedPages, rejectsWith } from "./fixtures.ts";

describe("PDF extraction", () => {
  test("extracts text, page count and version from a valid PDF", async () => {
    const result = await extractDocument(makePdf([["Grade 3 Science", LESSON], ["Parts of a plant: roots, stem, leaves."]]), "pdf");
    assert.match(result.text, /Grade 3 Science/);
    assert.match(result.text, /roots, stem, leaves/);
    assert.equal(result.page_count, 2);
    assert.equal(result.total_pages, 2);
    assert.equal(result.is_truncated, false);
    assert.match(result.extractor_version, /^tm-pdf-1\+pdfjs-6\.4\.299$/);
    assert.ok(result.extractor_version.length <= 40);
  });

  test("exactly 50 pages: all read, not truncated", async () => {
    const result = await extractDocument(makePdf(numberedPages(50)), "pdf");
    assert.equal(result.page_count, 50);
    assert.equal(result.total_pages, 50);
    assert.equal(result.is_truncated, false);
    assert.match(result.text, /Page 50 marker/);
  });

  test("more than 50 pages: only the first 50 are read and the result is flagged truncated", async () => {
    const result = await extractDocument(makePdf(numberedPages(60)), "pdf");
    assert.equal(result.page_count, 50);
    assert.equal(result.total_pages, 60);
    assert.equal(result.is_truncated, true);
    assert.match(result.text, /Page 1 marker/);
    assert.match(result.text, /Page 50 marker/);
    // The text is far below the character cap, so page 51 is absent because it was never read,
    // not because the output was cut afterwards.
    assert.ok(result.text.length < 20_000);
    assert.doesNotMatch(result.text, /Page 5[1-9] marker|Page 60 marker/);
  });

  test("character cap: stops reading pages early and flags truncation", async () => {
    // ~3,700 characters per page in 48 wrapped lines; 50 pages ≈ 185,000 characters.
    const filler = "Water cycle evaporation condensation precipitation collection. ".repeat(58);
    const result = await extractDocument(makePdf(numberedPages(50, filler)), "pdf");
    assert.ok(result.text.length <= 100_000, `length ${result.text.length}`);
    assert.equal(result.is_truncated, true);
    assert.ok((result.page_count ?? 0) < 50, `stopped after ${result.page_count} pages`);
  });

  test("password-protected PDF → ENCRYPTED_DOCUMENT", async () => {
    await rejectsWith(extractDocument(makePdf([[LESSON]], { encrypt: true }), "pdf"), "ENCRYPTED_DOCUMENT");
  });

  test("PDF with no text layer (drawing only, like a scan) → NO_TEXT", async () => {
    await rejectsWith(extractDocument(makePdf([[""]], { drawingOnly: true }), "pdf"), "NO_TEXT");
  });

  test("PDF with only a few characters → NO_TEXT", async () => {
    await rejectsWith(extractDocument(makePdf([["Hi", "..."]]), "pdf"), "NO_TEXT");
  });

  test("invalid signatures → TYPE_MISMATCH", async () => {
    for (const header of [" %PDF-1.4\n", "%PDF1.4\n", "%!PS-Adobe-3.0\n", "%pdf-1.4\n"]) {
      await rejectsWith(extractDocument(makePdf([[LESSON]], { header }), "pdf"), "TYPE_MISMATCH");
    }
  });

  test("damaged xref: PDF.js may rebuild it — recovered text is real, never invented", async () => {
    const valid = makePdf([[LESSON]]);
    const broken = latin1Bytes(new TextDecoder("latin1").decode(valid).replace(/startxref\n\d+/, "startxref\n999999999"));
    const result = await extractDocument(broken, "pdf");
    assert.equal(result.text, LESSON);
  });

  test("malformed PDFs → MALFORMED_DOCUMENT (or NO_TEXT), never another error", async () => {
    const valid = makePdf([[LESSON]]);
    const cases = {
      garbage: latin1Bytes("%PDF-1.7\n" + "\u0001ÿ garbage ".repeat(500)),
      headerOnly: latin1Bytes("%PDF-1.4\n"),
      truncatedHalf: valid.slice(0, Math.floor(valid.length / 2)),
      deepNesting: latin1Bytes("%PDF-1.4\n1 0 obj\n" + "[".repeat(100_000) + "\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF"),
      noCatalog: latin1Bytes("%PDF-1.4\ntrailer\n<< /Size 1 >>\nstartxref\n0\n%%EOF\n"),
    };
    for (const [label, bytes] of Object.entries(cases)) {
      await assert.rejects(extractDocument(bytes, "pdf"), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error, `${label}: unexpected ${String(error)}`);
        assert.ok(["MALFORMED_DOCUMENT", "NO_TEXT"].includes(String(error.code)), `${label}: ${String(error.code)}`);
        return true;
      });
    }
  });

  test("the caller's buffer is not detached or modified", async () => {
    const input = makePdf([[LESSON]]);
    const copy = input.slice();
    await extractDocument(input, "pdf");
    assert.equal(input.byteLength, copy.byteLength);
    assert.deepEqual(input, copy);
  });

  test("parallel extractions are independent", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => extractDocument(makePdf([[`Document ${i} unique`, LESSON]]), "pdf")),
    );
    results.forEach((result, i) => assert.match(result.text, new RegExp(`Document ${i} unique`)));
  });
});
