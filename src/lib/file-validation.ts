import { formatFileSize } from "@/lib/format";
import { UPLOAD_RULES } from "@/lib/presentation-options";

export type SupportedFileKind = "pdf" | "docx";

export type FileCheckResult = { kind: SupportedFileKind } | { error: string };

/**
 * Client-side pre-checks for a better upload experience.
 * NOT a security boundary — the server must re-validate type, size, and contents
 * when upload processing is implemented (see CLAUDE.md, Mode B requirements).
 */
export async function checkFile(file: File): Promise<FileCheckResult> {
  const name = file.name.toLowerCase();
  const kind: SupportedFileKind | null = name.endsWith(".pdf") ? "pdf" : name.endsWith(".docx") ? "docx" : null;

  if (!kind) {
    return { error: `“${file.name}” isn’t supported. Upload a PDF or DOCX file.` };
  }
  if (file.size === 0) {
    return { error: `“${file.name}” is empty.` };
  }
  if (file.size > UPLOAD_RULES.maxFileSizeBytes) {
    return {
      error: `“${file.name}” is ${formatFileSize(file.size)}. The limit is ${formatFileSize(UPLOAD_RULES.maxFileSizeBytes)}.`,
    };
  }

  // Don't trust the extension alone: check the file signature.
  // PDF starts with "%PDF-"; DOCX is a ZIP container starting with "PK\x03\x04".
  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const isPdf = header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46 && header[4] === 0x2d;
  const isZip = header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;

  if ((kind === "pdf" && !isPdf) || (kind === "docx" && !isZip)) {
    return { error: `“${file.name}” doesn’t look like a real ${kind.toUpperCase()} file.` };
  }

  return { kind };
}
