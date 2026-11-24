/**
 * Child-process PDF fuzz runner (spawned by robustness.test.ts; not a test file itself).
 *
 * PDF.js runs on the calling thread in Node and, for some corrupt page dictionaries, rejects an
 * internal promise that nothing observes. Running the fuzz loop here keeps that out of the test
 * runner and lets us classify every unhandled rejection by origin. Prints one JSON line.
 */
import { ExtractionError } from "../errors.ts";
import { extractDocument } from "../extract.ts";
import { FUZZ_ALLOWED_CODES, LESSON, makePdf, mutate, prng } from "./fixtures.ts";

const ownLeaks: string[] = [];
const pdfjsLeaks: Record<string, number> = {};
const unexpectedErrors: string[] = [];

process.on("unhandledRejection", (reason: unknown) => {
  const stack = reason instanceof Error ? String(reason.stack) : "";
  const name = reason instanceof Error ? reason.name : typeof reason;
  if (/[\\/]unpdf[\\/]dist[\\/]pdfjs\.mjs/.test(stack)) pdfjsLeaks[name] = (pdfjsLeaks[name] ?? 0) + 1;
  else ownLeaks.push(`${name}: ${stack.split("\n").slice(0, 3).join(" | ")}`);
});
process.on("uncaughtException", (error) => ownLeaks.push(`uncaught ${error.name}`));

const iterations = Number(process.argv[2] ?? 300);
const seed = makePdf([["Fuzz seed", LESSON], ["Second page text for fuzzing."]]);
const random = prng(1);
const outcomes: Record<string, number> = {};

for (let i = 0; i < iterations; i++) {
  try {
    await extractDocument(mutate(seed, random), "pdf", { deadlineMs: 3000 });
    outcomes.ok = (outcomes.ok ?? 0) + 1;
  } catch (error) {
    if (!(error instanceof ExtractionError) || !FUZZ_ALLOWED_CODES.has(error.code)) unexpectedErrors.push(`${i}: ${String(error)}`);
    else outcomes[error.code] = (outcomes[error.code] ?? 0) + 1;
  }
}
await new Promise((resolve) => setTimeout(resolve, 300)); // let late rejections surface

process.stdout.write(`${JSON.stringify({ iterations, outcomes, unexpectedErrors, ownLeaks, pdfjsLeaks })}\n`);
