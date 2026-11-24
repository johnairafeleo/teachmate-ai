/**
 * Synthetic test fixtures, generated in code (no binary files, no real documents).
 * - makePdf: minimal PDF 1.4 with Helvetica text, correct xref offsets, optional bogus /Encrypt.
 * - makeZip: hand-written ZIP container so headers can be made to lie (sizes, flags, CRC, names).
 * - makeDocx: OOXML packages built on makeZip.
 */
import assert from "node:assert/strict";
import { constants as zlibConstants, deflateRawSync } from "node:zlib";

import { deflateSync } from "fflate";

import { ExtractionError, type ExtractionErrorCode } from "../errors.ts";
import { crc32 } from "../zip.ts";

const utf8 = new TextEncoder();
export const latin1Bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
export const utf8Bytes = (text: string) => utf8.encode(text);

export const LESSON =
  "Photosynthesis is how green plants make their own food using sunlight, water and carbon dioxide.";

// ---------------------------------------------------------------- PDF

const pdfString = (text: string) => `(${text.replace(/[\\()]/g, (m) => `\\${m}`)})`;

export function makePdf(
  pages: readonly (readonly string[])[],
  options: { encrypt?: boolean; header?: string; drawingOnly?: boolean } = {},
): Uint8Array {
  const objects: string[] = [];
  const kids: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  let next = 4;
  for (const lines of pages) {
    const pageId = next++;
    const contentId = next++;
    kids.push(`${pageId} 0 R`);
    const stream = options.drawingOnly
      ? "0 0 1 rg 72 72 200 200 re f"
      : `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `${pdfString(line)} Tj T*`).join(" ")} ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let encryptRef = "";
  if (options.encrypt) {
    const id = next++;
    const hex = (n: number) => "ab".repeat(n);
    objects[id] = `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${hex(32)}> /U <${hex(32)}> /P -44 >>`;
    encryptRef = ` /Encrypt ${id} 0 R /ID [<${hex(16)}> <${hex(16)}>]`;
  }

  let out = options.header ?? "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  for (let id = 1; id < next; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${next} /Root 1 0 R${encryptRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1Bytes(out);
}

/**
 * Wrap text into ≤80-character lines. PDF.js 6 drops glyphs outside the page box, so fixture
 * lines must fit the page like real documents do (≤ 50 lines per page fit vertically).
 */
export function wrapLines(text: string, width = 80): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** n pages, each with a unique marker line plus (wrapped) filler text. */
export function numberedPages(count: number, filler = LESSON): string[][] {
  return Array.from({ length: count }, (_, i) => [`Page ${i + 1} marker`, ...wrapLines(filler)]);
}

/**
 * A single page whose content stream holds ~`mib` MiB of tiny text-show operators: one heavy,
 * uninterruptible PDF.js step. Offsets are left stale on purpose (PDF.js rebuilds the xref).
 */
export function densePdfPage(mib: number): Uint8Array {
  const ops: string[] = [];
  let size = 0;
  for (let i = 0; size < mib * 1024 * 1024; i++) {
    const op = `1 0 0 1 72 ${700 - (i % 600)} Tm (w${i % 1000}) Tj`;
    ops.push(op);
    size += op.length + 1;
  }
  const stream = `BT /F1 6 Tf ${ops.join(" ")} ET`;
  const base = new TextDecoder("latin1").decode(makePdf([["placeholder"]]));
  return latin1Bytes(base.replace(/<< \/Length \d+ >>\nstream\n[\s\S]*?\nendstream/, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
}

/**
 * A small, VALID PDF (real `%PDF-` header and xref) whose single /FlateDecode content stream
 * inflates to `decodedMiB` MiB of spaces followed by one line of real text. PDF.js decodes a
 * content stream into one growing ArrayBuffer, which V8 heap limits do not cover (TASK 005.7.1:
 * 600 MiB decoded → +1.27 GiB process RSS). ~1 KiB of file per MiB decoded.
 */
export function flateBombPdf(decodedMiB: number): Uint8Array {
  // One 1 MiB block compressed with Z_FULL_FLUSH is byte-aligned, non-final and does not refer to
  // earlier data, so repeating it N times is a valid deflate stream (built instantly).
  const block = deflateRawSync(new Uint8Array(1024 * 1024).fill(0x20), { finishFlush: zlibConstants.Z_FULL_FLUSH });
  const tail = deflateRawSync(latin1Bytes(" BT /F1 12 Tf 72 720 Td (Photosynthesis is how green plants make food.) Tj ET"));
  // zlib wrapper; PDF.js does not verify the Adler-32 trailer, so a placeholder is enough.
  const body = concatBytes([Uint8Array.of(0x78, 0x9c), ...Array.from({ length: decodedMiB }, () => block), tail, new Uint8Array(4)]);
  const head = latin1Bytes("%PDF-1.4\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    null, // the stream
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const chunks: Uint8Array[] = [head];
  const offsets: number[] = [];
  let length = head.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const bytes = object === null
      ? concatBytes([latin1Bytes(`${index + 1} 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`), body, latin1Bytes("\nendstream\nendobj\n")])
      : latin1Bytes(`${index + 1} 0 obj\n${object}\nendobj\n`);
    chunks.push(bytes);
    length += bytes.length;
  });
  const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(latin1Bytes(xref));
  return concatBytes(chunks);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------- ZIP

export type ZipSpec = {
  name: string;
  data: Uint8Array | string;
  method?: number;
  flags?: number;
  /** Lie about the uncompressed size (central + local headers). */
  declaredSize?: number;
  /** Override CRC-32. */
  crc?: number;
  /** Different name in the local header than in the central directory. */
  localName?: string;
};

function u16(view: DataView, at: number, value: number) {
  view.setUint16(at, value, true);
}
function u32(view: DataView, at: number, value: number) {
  view.setUint32(at, value >>> 0, true);
}

export function makeZip(specs: readonly ZipSpec[], options: { totalEntriesOverride?: number; zip64?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const spec of specs) {
    const raw = typeof spec.data === "string" ? utf8Bytes(spec.data) : spec.data;
    const method = spec.method ?? 8;
    const body = method === 8 ? deflateSync(raw, { level: 9 }) : raw;
    const name = utf8Bytes(spec.name);
    const localName = utf8Bytes(spec.localName ?? spec.name);
    const flags = (spec.flags ?? 0) | 0x0800;
    const crc = spec.crc ?? crc32(raw);
    const size = spec.declaredSize ?? raw.length;

    const local = new Uint8Array(30 + localName.length + body.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, flags); u16(lv, 8, method); u16(lv, 10, 0); u16(lv, 12, 0x21);
    u32(lv, 14, crc); u32(lv, 18, body.length); u32(lv, 22, size); u16(lv, 26, localName.length); u16(lv, 28, 0);
    local.set(localName, 30);
    local.set(body, 30 + localName.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014b50); u16(cv, 4, 20); u16(cv, 6, 20); u16(cv, 8, flags); u16(cv, 10, method); u16(cv, 12, 0); u16(cv, 14, 0x21);
    u32(cv, 16, crc); u32(cv, 20, body.length); u32(cv, 24, options.zip64 ? 0xffffffff : size);
    u16(cv, 28, name.length); u16(cv, 30, 0); u16(cv, 32, 0); u16(cv, 34, 0); u16(cv, 36, 0); u32(cv, 38, 0); u32(cv, 42, offset);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  const total = options.totalEntriesOverride ?? specs.length;
  u32(ev, 0, 0x06054b50); u16(ev, 4, 0); u16(ev, 6, 0); u16(ev, 8, total); u16(ev, 10, total);
  u32(ev, 12, cdSize); u32(ev, 16, offset); u16(ev, 20, 0);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------- DOCX

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  docm: "application/vnd.ms-word.document.macroEnabled.main+xml",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
};

export const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const contentTypesXml = (mainType = TYPES.docx, partName = "/word/document.xml", extra = "") =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="${partName}" ContentType="${mainType}"/>${extra}</Types>`;

export const documentXml = (body: string, prefix = "w") =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${prefix}:document xmlns:${prefix}="${W_NS}" xmlns:mc="${MC_NS}"><${prefix}:body>${body}</${prefix}:body></${prefix}:document>`;

export const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

const RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

export function makeDocx(
  options: {
    body?: string;
    document?: string | Uint8Array;
    contentTypes?: string;
    extra?: ZipSpec[];
    omit?: string[];
    override?: Partial<Record<string, Partial<ZipSpec>>>;
  } = {},
): Uint8Array {
  const parts: ZipSpec[] = [
    { name: "[Content_Types].xml", data: options.contentTypes ?? contentTypesXml() },
    { name: "_rels/.rels", data: RELS },
    { name: "word/document.xml", data: options.document ?? documentXml(options.body ?? para(LESSON)) },
    ...(options.extra ?? []),
  ];
  return makeZip(
    parts
      .filter((part) => !(options.omit ?? []).includes(part.name))
      .map((part) => ({ ...part, ...(options.override?.[part.name] ?? {}) })),
  );
}

/** Minimal OLE/CFB header; with `encrypted`, includes the UTF-16LE "EncryptionInfo" stream name. */
export function makeOle(encrypted: boolean): Uint8Array {
  const out = new Uint8Array(2048);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const name = encrypted ? "EncryptionInfo" : "WordDocument";
  out.set(Uint8Array.from([...name].flatMap((c) => [c.charCodeAt(0), 0])), 1024);
  return out;
}

// ---------------------------------------------------------------- fuzzing

/** Deterministic PRNG so fuzz failures are reproducible. */
export function prng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** One random mutation: byte flips, truncation, insertion or a filled range. */
export function mutate(bytes: Uint8Array, random: () => number): Uint8Array {
  const out = bytes.slice();
  const kind = Math.floor(random() * 4);
  if (kind === 0) {
    for (let i = 0; i < 1 + Math.floor(random() * 20); i++) out[Math.floor(random() * out.length)] = Math.floor(random() * 256);
  }
  if (kind === 1) return out.slice(0, Math.max(5, Math.floor(random() * out.length)));
  if (kind === 2) {
    const at = Math.floor(random() * out.length);
    const noise = Array.from({ length: 1 + Math.floor(random() * 64) }, () => Math.floor(random() * 256));
    return new Uint8Array([...out.slice(0, at), ...noise, ...out.slice(at)]);
  }
  if (kind === 3) out.fill(Math.floor(random() * 256), Math.floor(random() * out.length), Math.floor(random() * out.length));
  return out;
}

export const FUZZ_ALLOWED_CODES = new Set([
  "MALFORMED_DOCUMENT", "TYPE_MISMATCH", "NO_TEXT", "ENCRYPTED_DOCUMENT", "LIMITS_EXCEEDED",
  "UNSAFE_CONTENT", "MACRO_ENABLED", "NOT_A_WORD_DOCUMENT", "TIMEOUT",
]);

// ---------------------------------------------------------------- assertions

export async function rejectsWith(promise: Promise<unknown>, code: ExtractionErrorCode): Promise<ExtractionError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExtractionError, `expected ExtractionError(${code}), got ${caught === undefined ? "success" : String(caught)}`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code} (${caught.reason ?? "no reason"})`);
  return caught;
}
