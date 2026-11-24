import { assertBeforeDeadline, ExtractionError } from "./errors.ts";

/**
 * WordprocessingML text extraction without a general XML parser.
 *
 * - No DTD processing or entity expansion exists here at all: any `<!DOCTYPE`/`<!ENTITY`, or any
 *   markup declaration other than comments and CDATA, is rejected up front.
 * - Only the five predefined entities and numeric character references are decoded.
 * - The scanner is linear (indexOf-based, quote-aware), so crafted markup cannot cause
 *   regular-expression backtracking.
 */

const W_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main", // ISO/IEC 29500 Strict
]);
const MC_NAMESPACE = "http://schemas.openxmlformats.org/markup-compatibility/2006";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export function decodeXml(bytes: Uint8Array): string {
  try {
    return strictUtf8.decode(bytes); // strips a UTF-8 BOM; rejects UTF-16 and invalid UTF-8
  } catch {
    throw new ExtractionError("MALFORMED_DOCUMENT", "xml_encoding");
  }
}

/** Reject DTDs, entity declarations and any other markup declaration. */
export function assertSafeXml(xml: string): void {
  if (/<!\s*(DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i.test(xml)) {
    throw new ExtractionError("UNSAFE_CONTENT", "xml_doctype");
  }
  for (let at = xml.indexOf("<!"); at !== -1; at = xml.indexOf("<!", at + 2)) {
    if (!xml.startsWith("<!--", at) && !xml.startsWith("<![CDATA[", at)) {
      throw new ExtractionError("UNSAFE_CONTENT", "xml_markup");
    }
  }
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) attributes.set(match[1], match[2] ?? match[3] ?? "");
  return attributes;
}

export type WordContentType = "document" | "macro" | "template" | "spreadsheet" | "presentation" | "unknown";

const MAIN_TYPES: Record<string, WordContentType> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml": "document",
  "application/vnd.ms-word.document.macroenabled.main+xml": "macro",
  "application/vnd.ms-word.template.macroenabledtemplate.main+xml": "macro",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml": "template",
};

/** Classify the package from [Content_Types].xml: what is /word/document.xml declared to be? */
export function classifyContentTypes(xml: string): { main: WordContentType; hasMacroParts: boolean } {
  let main: WordContentType = "unknown";
  let other: WordContentType = "unknown";
  let hasMacroParts = false;
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?(Override|Default)\b([^>]*)>/g)) {
    const attributes = parseAttributes(match[2]);
    const type = (attributes.get("ContentType") ?? "").trim().toLowerCase();
    if (type.includes("vbaproject") || type.includes("macroenabled")) hasMacroParts = true;
    if (match[1] === "Override" && (attributes.get("PartName") ?? "").toLowerCase() === "/word/document.xml") {
      main = MAIN_TYPES[type] ?? "unknown";
    }
    if (type.includes("spreadsheetml.sheet.main") || type.includes("ms-excel")) other = "spreadsheet";
    if (type.includes("presentationml.presentation.main") || type.includes("ms-powerpoint")) other = "presentation";
  }
  return { main: main === "unknown" ? other : main, hasMacroParts };
}

const ENTITY = /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (_, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named];
    const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? "", 10);
    if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
    return String.fromCodePoint(code); // control characters are removed later by normalisation
  });
}

/** Elements whose content never belongs in the lesson text. */
const SKIPPED = new Set(["pPr", "rPr", "sectPr", "tblPr", "tblGrid", "trPr", "tcPr", "instrText", "delText", "delInstrText", "fldData", "sym"]);

/**
 * Walk word/document.xml and return readable text with paragraph and table boundaries:
 * paragraphs → newline; table cells → tab (paragraphs inside a cell → space); rows → newline;
 * tables are separated by blank lines. Stops early once `maxRawChars` is reached.
 */
export function wordDocumentText(xml: string, maxRawChars: number, deadlineAt: number): { raw: string; truncated: boolean } {
  // Root element and namespace prefixes.
  const rootMatch = /<((?:[\w.-]+:)?document)\b([^>]*)>/.exec(xml);
  if (!rootMatch) throw new ExtractionError("MALFORMED_DOCUMENT", "xml_root");
  const declarations = parseAttributes(rootMatch[2]);
  let w: string | undefined;
  let mc: string | undefined;
  for (const [attribute, value] of declarations) {
    if (!attribute.startsWith("xmlns:")) continue;
    if (W_NAMESPACES.has(value)) w = attribute.slice(6);
    if (value === MC_NAMESPACE) mc = attribute.slice(6);
  }
  const rootName = rootMatch[1];
  if (!w || rootName !== `${w}:document`) throw new ExtractionError("MALFORMED_DOCUMENT", "xml_root");
  const wPrefix = `${w}:`;

  const parts: string[] = [];
  let length = 0;
  let inText = 0;
  let skip = 0;
  let cellDepth = 0;
  let steps = 0;
  const emit = (value: string) => {
    if (skip > 0 || value.length === 0) return;
    parts.push(value);
    length += value.length;
  };

  let at = rootMatch.index;
  while (at < xml.length) {
    if ((++steps & 0xfff) === 0) assertBeforeDeadline(deadlineAt);
    if (length > maxRawChars) return { raw: parts.join(""), truncated: true };

    const lt = xml.indexOf("<", at);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > at && inText > 0) emit(decodeEntities(xml.slice(at, textEnd)));
    if (lt === -1) break;

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new ExtractionError("MALFORMED_DOCUMENT", "xml_markup");
      at = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new ExtractionError("MALFORMED_DOCUMENT", "xml_markup");
      if (inText > 0) emit(xml.slice(lt + 9, end));
      at = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new ExtractionError("MALFORMED_DOCUMENT", "xml_markup");
      at = end + 2;
      continue;
    }

    // Quote-aware scan to the end of the tag.
    let gt = lt + 1;
    let quote = 0;
    for (; gt < xml.length; gt++) {
      const c = xml.charCodeAt(gt);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) quote = c;
      else if (c === 62) break;
    }
    if (gt >= xml.length) throw new ExtractionError("MALFORMED_DOCUMENT", "xml_markup");

    const closing = xml.charCodeAt(lt + 1) === 47; // "</"
    const selfClosing = xml.charCodeAt(gt - 1) === 47; // "/>"
    const nameStart = closing ? lt + 2 : lt + 1;
    let nameEnd = nameStart;
    while (nameEnd < gt && !/[\s/>]/.test(xml[nameEnd])) nameEnd++;
    const qname = xml.slice(nameStart, nameEnd);
    at = gt + 1;

    if (mc && qname === `${mc}:Fallback`) {
      // Alternate content: keep the preferred branch only, otherwise text boxes appear twice.
      if (!closing && !selfClosing) skip++;
      else if (closing) skip = Math.max(0, skip - 1);
      continue;
    }
    if (!qname.startsWith(wPrefix)) continue;
    const local = qname.slice(wPrefix.length);

    if (SKIPPED.has(local)) {
      if (!closing && !selfClosing) skip++;
      else if (closing) skip = Math.max(0, skip - 1);
      continue;
    }

    if (closing) {
      switch (local) {
        case "t":
          inText = Math.max(0, inText - 1);
          break;
        case "p":
          emit(cellDepth > 0 ? " " : "\n");
          break;
        case "tc":
          cellDepth = Math.max(0, cellDepth - 1);
          emit("\t");
          break;
        case "tr":
          emit("\n");
          break;
        case "tbl":
          emit("\n");
          break;
      }
      continue;
    }

    switch (local) {
      case "t":
        if (!selfClosing) inText++;
        break;
      case "tab":
        emit("\t");
        break;
      case "br":
      case "cr":
        emit("\n");
        break;
      case "noBreakHyphen":
        emit("-");
        break;
      case "tc":
        if (!selfClosing) cellDepth++;
        break;
      case "tbl":
        emit("\n");
        break;
    }
  }
  return { raw: parts.join(""), truncated: false };
}
