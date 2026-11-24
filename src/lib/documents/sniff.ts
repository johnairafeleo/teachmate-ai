/** Content-based file type detection. Extensions and MIME types are never trusted on their own. */

export type SniffedKind = "pdf" | "zip" | "ole" | "unknown";

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-" at offset 0 (strict: no leading junk)
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06]; // empty archive
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // Compound File Binary (.doc, encrypted OOXML)

export function sniffKind(bytes: Uint8Array): SniffedKind {
  if (startsWith(bytes, PDF)) return "pdf";
  if (startsWith(bytes, ZIP_LOCAL) || startsWith(bytes, ZIP_EMPTY)) return "zip";
  if (startsWith(bytes, OLE)) return "ole";
  return "unknown";
}

/** UTF-16LE "EncryptionInfo": the stream an Office-encrypted .docx carries inside its OLE container. */
const ENCRYPTION_INFO = new Uint8Array([..."EncryptionInfo"].flatMap((char) => [char.charCodeAt(0), 0]));

export function oleLooksEncrypted(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 4 * 1024 * 1024) - ENCRYPTION_INFO.length;
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < ENCRYPTION_INFO.length; j++) {
      if (bytes[i + j] !== ENCRYPTION_INFO[j]) continue outer;
    }
    return true;
  }
  return false;
}
