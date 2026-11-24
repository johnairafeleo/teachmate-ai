import { assertSafeXml, classifyContentTypes, decodeXml, wordDocumentText } from "./docx-xml.ts";
import { ExtractionError } from "./errors.ts";
import { EXTRACTION_LIMITS } from "./limits.ts";
import { findEntry, readCentralDirectory, readEntry } from "./zip.ts";

/**
 * DOCX: only two parts are ever decompressed — [Content_Types].xml and word/document.xml.
 * Embedded objects, media, macros (vbaProject.bin), headers, footers and comments are never read.
 */
export function extractDocxText(bytes: Uint8Array, deadlineAt: number): { raw: string; truncated: boolean } {
  const entries = readCentralDirectory(bytes);

  const contentTypesEntry = findEntry(entries, "[Content_Types].xml");
  if (!contentTypesEntry) throw new ExtractionError("TYPE_MISMATCH", "content_types"); // a plain ZIP, JAR, …
  const contentTypes = decodeXml(readEntry(bytes, contentTypesEntry, EXTRACTION_LIMITS.zip.maxContentTypesBytes, deadlineAt));
  assertSafeXml(contentTypes);

  const { main, hasMacroParts } = classifyContentTypes(contentTypes);
  const hasVbaProject = entries.some((entry) => /(^|\/)vbaProject\.bin$/i.test(entry.name));
  if (main === "macro" || hasMacroParts || hasVbaProject) throw new ExtractionError("MACRO_ENABLED");
  if (main === "template" || main === "spreadsheet" || main === "presentation") throw new ExtractionError("NOT_A_WORD_DOCUMENT");
  if (main !== "document") throw new ExtractionError("MALFORMED_DOCUMENT", "content_types");

  const documentEntry = findEntry(entries, "word/document.xml");
  if (!documentEntry) throw new ExtractionError("MALFORMED_DOCUMENT", "zip_structure");
  const documentXml = decodeXml(readEntry(bytes, documentEntry, EXTRACTION_LIMITS.zip.maxDocumentXmlBytes, deadlineAt));
  assertSafeXml(documentXml);

  return wordDocumentText(documentXml, EXTRACTION_LIMITS.maxRawChars, deadlineAt);
}
