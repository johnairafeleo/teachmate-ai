import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { countMeaningfulChars, normalizeExtractedText as norm, truncateText } from "../normalize.ts";

describe("normalizeExtractedText", () => {
  test("Unicode NFC", () => {
    assert.equal(norm("Cafe\u0301 nin\u0303o"), "Caf\u00E9 ni\u00F1o");
  });
  test("removes NUL, C0/C1 controls and DEL but keeps tab and newline", () => {
    assert.equal(norm("a\u0000b\u0007c\u001bd\u007fe\u0090f\tg\nh"), "abcdef\tg\nh");
  });
  test("removes bidi overrides, zero-width/invisible format chars and Unicode tag characters", () => {
    assert.equal(norm("safe\u202Eevil\u202C \u2066x\u2069 zero\u200Bwidth \uFEFFbom soft\u00ADhyphen"), "safeevil x zerowidth bom softhyphen");
    assert.equal(norm("visible\u{E0041}\u{E0042}\u{E007F} text"), "visible text");
  });
  test("keeps meaningful characters: emoji ZWJ sequences, Filipino and other scripts", () => {
    assert.equal(norm("Guro \u{1F469}\u200D\u{1F3EB}: Ma\u00F1anita, \u170A\u170C\u1714\u170A\u170C\u1712\u1708\u1714, \u65E5\u672C\u8A9E"), "Guro \u{1F469}\u200D\u{1F3EB}: Ma\u00F1anita, \u170A\u170C\u1714\u170A\u170C\u1712\u1708\u1714, \u65E5\u672C\u8A9E");
  });
  test("line breaks: CRLF/CR/NEL/LS \u2192 LF, form feed \u2192 paragraph break, \u22641 blank line", () => {
    assert.equal(norm("a\r\nb\rc\u0085d\u2028e\ff\n\n\n\n\ng"), "a\nb\nc\nd\ne\n\nf\n\ng");
  });
  test("whitespace: exotic spaces \u2192 space, runs collapsed, tabs kept, lines trimmed", () => {
    assert.equal(norm("  one\u00A0\u00A0two\u3000three  \n\tfour \t five  "), "one two three\nfour\tfive");
  });
  test("lone surrogates become U+FFFD", () => {
    assert.equal(norm("x\ud800y"), "x\uFFFDy");
  });
});

describe("truncateText", () => {
  test("unchanged when within the limit", () => {
    assert.deepEqual(truncateText("short text", 100), { text: "short text", truncated: false });
  });
  test("cuts at a word boundary", () => {
    const { text, truncated } = truncateText("alpha beta gamma delta", 13);
    assert.equal(truncated, true);
    assert.equal(text, "alpha beta");
  });
  test("never splits a surrogate pair", () => {
    const { text } = truncateText(`${"x".repeat(9)}\u{1F600}\u{1F600}`, 10);
    assert.equal(text, "x".repeat(9));
    assert.ok(text.toWellFormed() === text);
  });
  test("result never exceeds the limit", () => {
    const input = "word ".repeat(50_000);
    assert.ok(truncateText(input, 100_000).text.length <= 100_000);
  });
});

describe("countMeaningfulChars", () => {
  test("counts letters and digits only", () => {
    assert.equal(countMeaningfulChars("Hi! 123 ... \u00F1 \u65E5"), 7);
  });
});
