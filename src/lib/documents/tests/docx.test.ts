import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractDocument } from "../extract.ts";
import {
  contentTypesXml,
  documentXml,
  LESSON,
  makeDocx,
  makeOle,
  makeZip,
  para,
  rejectsWith,
  TYPES,
  utf8Bytes,
  type ZipSpec,
} from "./fixtures.ts";

const MiB = 1024 * 1024;
const docx = (body: string) => extractDocument(makeDocx({ body }), "docx");

describe("DOCX: valid documents", () => {
  test("extracts paragraphs with line breaks", async () => {
    const result = await docx(para("Lesson 1: Plants") + para(LESSON));
    assert.equal(result.text, `Lesson 1: Plants\n${LESSON}`);
    assert.equal(result.page_count, null);
    assert.equal(result.is_truncated, false);
    assert.match(result.extractor_version, /^tm-docx-1\+fflate-0\.8\.3$/);
  });

  test("tables: cells \u2192 tab, rows \u2192 newline, table separated from paragraphs", async () => {
    const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr>${para(text)}</w:tc>`;
    const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;
    const table = `<w:tbl><w:tblPr/><w:tblGrid/>${row("Planet", "Moons")}${row("Earth", "1")}${row("Mars", "2")}</w:tbl>`;
    const result = await docx(para("Our solar system has eight planets orbiting the Sun.") + table + para("End of table."));
    assert.equal(result.text, "Our solar system has eight planets orbiting the Sun.\n\nPlanet\tMoons\nEarth\t1\nMars\t2\n\nEnd of table.");
  });

  test("tabs, breaks, hyphens; deleted text, field codes, tab stops and fallback content excluded", async () => {
    const body =
      `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` +
      `<w:r><w:t>Name:</w:t><w:tab/><w:t>Maria</w:t><w:br/><w:t>non</w:t><w:noBreakHyphen/><w:t>stop reading every day</w:t></w:r>` +
      `<w:del><w:r><w:delText>DELETED SECRET</w:delText></w:r></w:del>` +
      `<w:r><w:instrText> HYPERLINK "http://example.invalid" </w:instrText></w:r>` +
      `<mc:AlternateContent><mc:Choice><w:r><w:t> once</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t> twice</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>` +
      para(LESSON);
    const result = await docx(body);
    assert.equal(result.text.split("\n")[0], "Name:\tMaria");
    assert.match(result.text, /non-stop reading every day once/);
    assert.doesNotMatch(result.text, /DELETED|HYPERLINK|twice|left/);
  });

  test("a non-'w' namespace prefix is resolved from the root element", async () => {
    const body = `<x:p><x:r><x:t>${LESSON}</x:t></x:r></x:p>`;
    const result = await extractDocument(makeDocx({ document: documentXml(body, "x") }), "docx");
    assert.equal(result.text, LESSON);
  });

  test("entities and character references decode; other markup is never expanded", async () => {
    const result = await docx(`<w:p><w:r><w:t>Fish &amp; chips &lt;3 &#233;t&#xE9; &unknown; ${LESSON}</w:t></w:r></w:p>`);
    assert.equal(result.text, `Fish & chips <3 \u00E9t\u00E9 &unknown; ${LESSON}`);
  });

  test("output limited to 100,000 characters at a word boundary", async () => {
    const paragraphs = Array.from({ length: 2500 }, (_, i) => para(`Paragraph ${i} about the water cycle and weather patterns.`)).join("");
    const result = await docx(paragraphs);
    assert.ok(result.text.length <= 100_000);
    assert.equal(result.is_truncated, true);
    assert.match(result.text.slice(-1), /\S/);
  });

  test("exactly 1,000 ZIP entries is allowed", async () => {
    const extra = Array.from({ length: 997 }, (_, i): ZipSpec => ({ name: `word/media/filler${i}.bin`, data: "x", method: 0 }));
    const result = await extractDocument(makeDocx({ extra }), "docx");
    assert.equal(result.text, LESSON);
  });
});

describe("DOCX: impostors and unsupported packages", () => {
  test("DOCM (macro-enabled main part) \u2192 MACRO_ENABLED", async () => {
    await rejectsWith(extractDocument(makeDocx({ contentTypes: contentTypesXml(TYPES.docm) }), "docx"), "MACRO_ENABLED");
  });

  test("vbaProject.bin inside an otherwise normal package \u2192 MACRO_ENABLED", async () => {
    await rejectsWith(extractDocument(makeDocx({ extra: [{ name: "word/vbaProject.bin", data: "macro" }] }), "docx"), "MACRO_ENABLED");
  });

  test("XLSX disguised as DOCX \u2192 NOT_A_WORD_DOCUMENT", async () => {
    const xlsx = makeZip([
      { name: "[Content_Types].xml", data: contentTypesXml(TYPES.xlsx, "/xl/workbook.xml") },
      { name: "xl/workbook.xml", data: "<workbook/>" },
    ]);
    await rejectsWith(extractDocument(xlsx, "docx"), "NOT_A_WORD_DOCUMENT");
  });

  test("PPTX and DOTX \u2192 NOT_A_WORD_DOCUMENT", async () => {
    const pptx = makeZip([{ name: "[Content_Types].xml", data: contentTypesXml(TYPES.pptx, "/ppt/presentation.xml") }]);
    await rejectsWith(extractDocument(pptx, "docx"), "NOT_A_WORD_DOCUMENT");
    await rejectsWith(extractDocument(makeDocx({ contentTypes: contentTypesXml(TYPES.dotx) }), "docx"), "NOT_A_WORD_DOCUMENT");
  });

  test("plain ZIP without [Content_Types].xml \u2192 TYPE_MISMATCH", async () => {
    await rejectsWith(extractDocument(makeZip([{ name: "readme.txt", data: LESSON }]), "docx"), "TYPE_MISMATCH");
  });

  test("missing word/document.xml \u2192 MALFORMED_DOCUMENT", async () => {
    await rejectsWith(extractDocument(makeDocx({ omit: ["word/document.xml"] }), "docx"), "MALFORMED_DOCUMENT");
  });

  test("document part declared under another content type \u2192 MALFORMED_DOCUMENT", async () => {
    await rejectsWith(extractDocument(makeDocx({ contentTypes: contentTypesXml("application/xml") }), "docx"), "MALFORMED_DOCUMENT");
  });

  test("invalid structures \u2192 MALFORMED_DOCUMENT", async () => {
    const good = makeDocx();
    const cases: Record<string, Uint8Array> = {
      notXml: makeDocx({ document: new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02]) }),
      wrongRoot: makeDocx({ document: `<?xml version="1.0"?><html><body>${LESSON}</body></html>` }),
      wrongNamespace: makeDocx({ document: `<w:document xmlns:w="urn:not-word"><w:body>${para(LESSON)}</w:body></w:document>` }),
      unclosedTag: makeDocx({ document: documentXml(para(LESSON)).replace("</w:document>", "<w:p") }),
      crcMismatch: makeDocx({ override: { "word/document.xml": { crc: 0x12345678 } } }),
      nameMismatch: makeDocx({ override: { "word/document.xml": { localName: "word/evil.xml" } } }),
      unsupportedMethod: makeDocx({ override: { "word/document.xml": { method: 12 } } }),
      duplicateNames: makeZip([
        { name: "[Content_Types].xml", data: contentTypesXml() },
        { name: "word/document.xml", data: documentXml(para(LESSON)) },
        { name: "WORD/document.xml", data: documentXml(para("Shadow copy")) },
      ]),
      zip64: makeZip([{ name: "[Content_Types].xml", data: contentTypesXml() }], { zip64: true }),
      truncated: good.slice(0, good.length - 10),
      wrongEntryCount: makeDocx().slice(),
    };
    // EOCD says 4 entries, central directory has 3.
    const view = new DataView(cases.wrongEntryCount.buffer);
    view.setUint16(cases.wrongEntryCount.length - 22 + 8, 4, true);
    view.setUint16(cases.wrongEntryCount.length - 22 + 10, 4, true);
    for (const [label, bytes] of Object.entries(cases)) {
      const error = await rejectsWith(extractDocument(bytes, "docx"), "MALFORMED_DOCUMENT").catch((e: unknown) => {
        throw new Error(`${label}: ${String(e)}`);
      });
      assert.ok(error.message.length < 120, label);
    }
  });

  test("invalid UTF-8 in document.xml \u2192 MALFORMED_DOCUMENT", async () => {
    const bytes = utf8Bytes(documentXml(para(LESSON)));
    bytes[bytes.indexOf(0x50)] = 0xc3; // lone lead byte
    await rejectsWith(extractDocument(makeDocx({ document: bytes }), "docx"), "MALFORMED_DOCUMENT");
  });
});

describe("DOCX: encryption", () => {
  test("ZIP entries with the encryption flag \u2192 ENCRYPTED_DOCUMENT", async () => {
    await rejectsWith(extractDocument(makeDocx({ override: { "word/document.xml": { flags: 0x0001 } } }), "docx"), "ENCRYPTED_DOCUMENT");
  });

  test("AES-encrypted entry (method 99) \u2192 ENCRYPTED_DOCUMENT", async () => {
    await rejectsWith(extractDocument(makeDocx({ override: { "word/document.xml": { method: 99 } } }), "docx"), "ENCRYPTED_DOCUMENT");
  });

  test("Office-encrypted .docx (OLE container with EncryptionInfo) \u2192 ENCRYPTED_DOCUMENT", async () => {
    await rejectsWith(extractDocument(makeOle(true), "docx"), "ENCRYPTED_DOCUMENT");
  });

  test("legacy .doc renamed to .docx \u2192 TYPE_MISMATCH", async () => {
    await rejectsWith(extractDocument(makeOle(false), "docx"), "TYPE_MISMATCH");
  });
});

describe("DOCX: decompression limits (ZIP bombs)", () => {
  test("ZIP bomb with honest headers (30 MiB of zeros) is rejected from the central directory", async () => {
    const bomb = makeDocx({ extra: [{ name: "word/media/bomb.bin", data: new Uint8Array(30 * MiB) }] });
    assert.ok(bomb.length < 100_000, `bomb is ${bomb.length} bytes`);
    const error = await rejectsWith(extractDocument(bomb, "docx"), "LIMITS_EXCEEDED");
    assert.equal(error.reason, "zip_ratio");
  });

  test("ZIP bomb with a lying header: actual output is capped while inflating", async () => {
    const xml = documentXml(para(LESSON) + `<w:p><w:r><w:t>${" ".repeat(15 * MiB)}</w:t></w:r></w:p>`);
    const bomb = makeDocx({ override: { "word/document.xml": { data: xml, declaredSize: 100_000 } } });
    const error = await rejectsWith(extractDocument(bomb, "docx"), "LIMITS_EXCEEDED");
    assert.ok(["zip_structure", "zip_ratio"].includes(String(error.reason)), String(error.reason));
  });

  test("ratio is enforced on ACTUAL bytes while inflating, not only from headers", async () => {
    // Overall ratio is harmless (~6:1, passes the central-directory check), but the first part
    // inflates at >100:1 — the streaming check must stop it mid-entry.
    const random = Buffer.from(Array.from({ length: 1024 * 1024 }, () => Math.floor(Math.random() * 256))).toString("base64");
    const xml = documentXml(`<w:p><w:r><w:t>${"a".repeat(5 * MiB)}${random}</w:t></w:r></w:p>` + para(LESSON));
    const bytes = makeDocx({ document: xml });
    const error = await rejectsWith(extractDocument(bytes, "docx"), "LIMITS_EXCEEDED");
    assert.equal(error.reason, "zip_ratio");
  });

  test("more than 1,000 entries \u2192 LIMITS_EXCEEDED", async () => {
    const extra = Array.from({ length: 998 }, (_, i): ZipSpec => ({ name: `word/media/f${i}.bin`, data: "x", method: 0 }));
    const error = await rejectsWith(extractDocument(makeDocx({ extra }), "docx"), "LIMITS_EXCEEDED");
    assert.equal(error.reason, "zip_entries");
  });

  test("EOCD claiming more than 1,000 entries \u2192 LIMITS_EXCEEDED before parsing", async () => {
    const zip = makeZip([{ name: "[Content_Types].xml", data: contentTypesXml() }], { totalEntriesOverride: 5000 });
    const error = await rejectsWith(extractDocument(zip, "docx"), "LIMITS_EXCEEDED");
    assert.equal(error.reason, "zip_entries");
  });

  test("declared total over 50 MiB \u2192 LIMITS_EXCEEDED", async () => {
    // Each entry claims 9 MiB from 100 KiB (ratio ~92:1, allowed); six of them exceed 50 MiB.
    const extra = Array.from({ length: 6 }, (_, i): ZipSpec => ({
      name: `word/media/p${i}.bin`, data: new Uint8Array(100 * 1024), method: 0, declaredSize: 9 * MiB,
    }));
    const error = await rejectsWith(extractDocument(makeDocx({ extra }), "docx"), "LIMITS_EXCEEDED");
    assert.equal(error.reason, "zip_total_size");
  });

  test("document.xml declared over 20 MiB \u2192 LIMITS_EXCEEDED without inflating", async () => {
    const bomb = makeDocx({ override: { "word/document.xml": { declaredSize: 21 * MiB } } });
    const error = await rejectsWith(extractDocument(bomb, "docx"), "LIMITS_EXCEEDED");
    assert.ok(["zip_entry_size", "zip_ratio"].includes(String(error.reason)), String(error.reason));
  });

  test("oversized document.xml with honest header (21 MiB of varied text) \u2192 LIMITS_EXCEEDED", async () => {
    let filler = "";
    for (let i = 0; filler.length < 21 * MiB; i++) filler += `<w:p><w:r><w:t>Sentence ${i} ${(i * 7919) % 10007} plants roots.</w:t></w:r></w:p>`;
    const bytes = makeDocx({ document: documentXml(filler) });
    assert.ok(bytes.length <= 10 * MiB, `fixture is ${(bytes.length / MiB).toFixed(1)} MiB`);
    const error = await rejectsWith(extractDocument(bytes, "docx"), "LIMITS_EXCEEDED");
    assert.equal(error.reason, "zip_entry_size");
  });

  test("only [Content_Types].xml and word/document.xml are ever inflated", async () => {
    // A corrupt embedded object would fail CRC/inflate if it were read; extraction still succeeds.
    const extra: ZipSpec[] = [
      { name: "word/embeddings/oleObject1.bin", data: new Uint8Array(500_000).fill(7), crc: 1 },
      { name: "word/media/image1.png", data: "not really a png", crc: 2 },
      { name: "../../etc/passwd", data: "root:x:0:0", crc: 3 },
    ];
    const result = await extractDocument(makeDocx({ extra }), "docx");
    assert.equal(result.text, LESSON);
  });
});

describe("DOCX: unsafe XML", () => {
  const cases = {
    doctype: `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x "boom">]>${documentXml(para(LESSON)).replace(/^<\?xml[^>]*\?>\n/, "")}`,
    lowercaseDoctype: documentXml(para(LESSON)).replace("<w:body>", "<w:body><!doctype x>"),
    billionLaughs: `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><w:document xmlns:w="${"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}"><w:body><w:p><w:r><w:t>&lol2;</w:t></w:r></w:p></w:body></w:document>`,
    externalEntity: documentXml(para(LESSON)).replace("<w:body>", '<!ENTITY xxe SYSTEM "file:///etc/passwd"><w:body>'),
    otherDeclaration: documentXml(para(LESSON)).replace("<w:body>", "<!ELEMENT w:body ANY><w:body>"),
  };
  for (const [label, xml] of Object.entries(cases)) {
    test(`${label} in document.xml \u2192 UNSAFE_CONTENT`, async () => {
      await rejectsWith(extractDocument(makeDocx({ document: xml }), "docx"), "UNSAFE_CONTENT");
    });
  }
  test("DOCTYPE in [Content_Types].xml \u2192 UNSAFE_CONTENT", async () => {
    const types = contentTypesXml().replace("<Types", '<!DOCTYPE Types SYSTEM "http://example.invalid/x.dtd"><Types');
    await rejectsWith(extractDocument(makeDocx({ contentTypes: types }), "docx"), "UNSAFE_CONTENT");
  });
  test("comments and CDATA are allowed", async () => {
    const result = await docx(`<!-- a comment --><w:p><w:r><w:t><![CDATA[${LESSON}]]></w:t></w:r></w:p>`);
    assert.equal(result.text, LESSON);
  });
});

describe("DOCX: no meaningful text", () => {
  test("empty paragraphs / punctuation only \u2192 NO_TEXT", async () => {
    await rejectsWith(docx("<w:p/><w:p><w:r><w:t>  ...  !!! </w:t></w:r></w:p>"), "NO_TEXT");
    await rejectsWith(docx(""), "NO_TEXT");
  });
});
