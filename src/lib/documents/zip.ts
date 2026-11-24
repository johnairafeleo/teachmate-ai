import { Inflate } from "fflate";

import { assertBeforeDeadline, ExtractionError } from "./errors.ts";
import { EXTRACTION_LIMITS } from "./limits.ts";

/**
 * Minimal, bounded ZIP reader for OOXML containers.
 *
 * - Parses the central directory itself (no third-party archive walker), so entry counts,
 *   encryption flags, ZIP64 markers, duplicate names and declared sizes are checked before any
 *   byte is inflated.
 * - Inflates only the entries a caller asks for, in small compressed chunks with fflate's
 *   streaming Inflate, counting ACTUAL output bytes while decompressing. Declared sizes can lie;
 *   output beyond min(declared size, per-entry cap, ratio × compressed bytes consumed) aborts
 *   immediately.
 * - Verifies CRC-32 of every inflated entry. Nothing is ever written to disk.
 */

const LIMITS = EXTRACTION_LIMITS.zip;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const malformed = (reason: "zip_structure" | "zip64" = "zip_structure") => new ExtractionError("MALFORMED_DOCUMENT", reason);

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndOfCentralDirectory(bytes: Uint8Array, dv: DataView): number {
  const minStart = Math.max(0, bytes.length - (22 + 0xffff));
  for (let offset = bytes.length - 22; offset >= minStart; offset--) {
    if (dv.getUint32(offset, true) === SIG_EOCD) return offset;
  }
  throw malformed();
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

/** Read and validate the central directory. Throws before inflating anything. */
export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < 22) throw malformed();
  const dv = view(bytes);
  const eocd = findEndOfCentralDirectory(bytes, dv);

  const diskNumber = dv.getUint16(eocd + 4, true);
  const cdDisk = dv.getUint16(eocd + 6, true);
  const entriesOnDisk = dv.getUint16(eocd + 8, true);
  const totalEntries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw malformed("zip64");
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) throw malformed();
  if (totalEntries > LIMITS.maxEntries) throw new ExtractionError("LIMITS_EXCEEDED", "zip_entries");
  if (cdOffset + cdSize > eocd) throw malformed();

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  let offset = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > eocd || dv.getUint32(offset, true) !== SIG_CENTRAL) throw malformed();
    const flags = dv.getUint16(offset + 8, true);
    const method = dv.getUint16(offset + 10, true);
    const crc32 = dv.getUint32(offset + 16, true);
    const compressedSize = dv.getUint32(offset + 20, true);
    const uncompressedSize = dv.getUint32(offset + 24, true);
    const nameLength = dv.getUint16(offset + 28, true);
    const extraLength = dv.getUint16(offset + 30, true);
    const commentLength = dv.getUint16(offset + 32, true);
    const localHeaderOffset = dv.getUint32(offset + 42, true);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > eocd) throw malformed();

    const rawName = bytes.subarray(offset + 46, nameEnd);
    const name = (flags & 0x0800 ? utf8 : latin1).decode(rawName);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw malformed("zip64");
    }
    // Encrypted (traditional PKWARE bit 0, strong encryption bit 6) or AES (method 99).
    if (flags & 0x0001 || flags & 0x0040 || method === 99) throw new ExtractionError("ENCRYPTED_DOCUMENT");

    const key = name.toLowerCase();
    if (seen.has(key)) throw malformed();
    seen.add(key);

    declaredTotal += uncompressedSize;
    if (declaredTotal > LIMITS.maxTotalUncompressedBytes) throw new ExtractionError("LIMITS_EXCEEDED", "zip_total_size");
    if (uncompressedSize > LIMITS.ratioExemptBytes && uncompressedSize > LIMITS.maxCompressionRatio * Math.max(compressedSize, 1)) {
      throw new ExtractionError("LIMITS_EXCEEDED", "zip_ratio");
    }
    if (localHeaderOffset + 30 > cdOffset || localHeaderOffset + 30 + compressedSize > cdOffset) throw malformed();

    entries.push({ name, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== cdOffset + cdSize) throw malformed();
  return entries;
}

export function findEntry(entries: readonly ZipEntry[], name: string): ZipEntry | undefined {
  const key = name.toLowerCase();
  return entries.find((entry) => entry.name.toLowerCase() === key);
}

/**
 * Inflate one entry with hard limits on ACTUAL output, enforced while decompressing.
 * `maxBytes` is the per-entry cap; the declared size and compression ratio cap it further.
 */
export function readEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number, deadlineAt: number): Uint8Array {
  if (entry.uncompressedSize > maxBytes) throw new ExtractionError("LIMITS_EXCEEDED", "zip_entry_size");

  const dv = view(bytes);
  const local = entry.localHeaderOffset;
  if (local + 30 > bytes.length || dv.getUint32(local, true) !== SIG_LOCAL) throw malformed();
  const localFlags = dv.getUint16(local + 6, true);
  const localMethod = dv.getUint16(local + 8, true);
  const localNameLength = dv.getUint16(local + 26, true);
  const localExtraLength = dv.getUint16(local + 28, true);
  if (localFlags & 0x0001 || localFlags & 0x0040 || localMethod === 99) throw new ExtractionError("ENCRYPTED_DOCUMENT");
  if (localMethod !== entry.method) throw malformed();
  const localName = bytes.subarray(local + 30, local + 30 + localNameLength);
  const centralName = (entry.flags & 0x0800 ? utf8 : latin1).decode(localName);
  if (centralName !== entry.name) throw malformed();

  const dataStart = local + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw malformed();

  const cap = Math.min(maxBytes, entry.uncompressedSize);
  let output: Uint8Array;

  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) throw malformed();
    output = bytes.slice(dataStart, dataEnd);
  } else if (entry.method === 8) {
    output = new Uint8Array(cap);
    let produced = 0;
    let consumed = 0;
    let finished = false;
    const inflater = new Inflate((chunk, final) => {
      if (produced + chunk.length > cap) {
        throw new ExtractionError("LIMITS_EXCEEDED", produced + chunk.length > maxBytes ? "zip_entry_size" : "zip_structure");
      }
      const total = produced + chunk.length;
      if (total > LIMITS.ratioExemptBytes && total > LIMITS.maxCompressionRatio * Math.max(consumed, 1)) {
        throw new ExtractionError("LIMITS_EXCEEDED", "zip_ratio");
      }
      output.set(chunk, produced);
      produced = total;
      if (final) finished = true;
    });
    try {
      for (let at = dataStart; at < dataEnd; at += LIMITS.inflateChunkBytes) {
        assertBeforeDeadline(deadlineAt);
        const end = Math.min(at + LIMITS.inflateChunkBytes, dataEnd);
        consumed = end - dataStart;
        inflater.push(bytes.subarray(at, end), end === dataEnd);
      }
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      throw malformed();
    }
    if (!finished && entry.compressedSize > 0) throw malformed();
    if (produced !== entry.uncompressedSize) throw malformed();
  } else {
    throw new ExtractionError("MALFORMED_DOCUMENT", "zip_method");
  }

  if (crc32(output) !== entry.crc32) throw new ExtractionError("MALFORMED_DOCUMENT", "zip_crc");
  return output;
}

let CRC_TABLE: Uint32Array | undefined;

export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
