/**
 * Text normalisation shared by all extractors:
 * - well-formed UTF-16 (lone surrogates → U+FFFD), Unicode NFC
 * - unified line breaks; form feeds become paragraph breaks
 * - NUL, C0/C1 controls (except tab/newline), bidi overrides, zero-width/invisible format
 *   characters and Unicode "tag" characters removed (used to hide text from readers)
 * - exotic spaces → space, collapsed runs, trimmed lines, at most one blank line in a row
 */

const LINE_SEPARATORS = /\r\n?|[\u0085\u2028\u2029]/g;
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\uFFFE\uFFFF\u{E0000}-\u{E007F}]/gu;
const EXOTIC_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const MEANINGFUL = /[\p{L}\p{N}]/gu;

export function normalizeExtractedText(raw: string): string {
  let text = raw.toWellFormed().normalize("NFC");
  text = text.replace(LINE_SEPARATORS, "\n").replace(/\f/g, "\n\n");
  text = text.replace(UNSAFE_CHARS, "").replace(EXOTIC_SPACES, " ");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, (run) => (run.includes("\t") ? "\t" : " ")).trim())
    .join("\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Cut to `maxChars` at a word boundary when one is close, never inside a surrogate pair. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = maxChars;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  const window = text.slice(Math.max(0, cut - 500), cut);
  const lastBreak = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"), window.lastIndexOf("\t"));
  if (lastBreak > 0) cut = cut - window.length + lastBreak;
  return { text: text.slice(0, cut).trimEnd(), truncated: true };
}

export function countMeaningfulChars(text: string): number {
  return text.match(MEANINGFUL)?.length ?? 0;
}
