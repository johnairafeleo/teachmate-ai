/**
 * Measurement runner (not a test): one scenario per process so peak RSS is attributable.
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/lib/documents/tests/measure-runner.ts <scenario>
 * Reports wall time, the longest event-loop stall (largest gap between 1 ms interval ticks) and
 * peak RSS (process.resourceUsage().maxRSS) as one JSON line.
 */
import { extractDocument } from "../extract.ts";
import { densePdfPage, documentXml, LESSON, makeDocx, makePdf, numberedPages } from "./fixtures.ts";

const MiB = 1024 * 1024;
const scenario = process.argv[2] ?? "";

function bigDocx(xmlMiB: number) {
  let xml = "";
  for (let i = 0; xml.length < xmlMiB * MiB; i++) xml += `<w:p><w:r><w:t>Sentence ${i} ${(i * 7919) % 10007} about plants.</w:t></w:r></w:p>`;
  return makeDocx({ document: documentXml(xml) });
}


const scenarios: Record<string, () => { bytes: Uint8Array; kind: "pdf" | "docx"; deadlineMs?: number }> = {
  "docx-18MiB-xml": () => ({ bytes: bigDocx(18), kind: "docx" }),
  "docx-zip-bomb-honest": () => ({ bytes: makeDocx({ extra: [{ name: "word/media/bomb.bin", data: new Uint8Array(30 * MiB) }] }), kind: "docx" }),
  "docx-zip-bomb-lying": () => ({
    bytes: makeDocx({ override: { "word/document.xml": { data: documentXml(`<w:p><w:r><w:t>${" ".repeat(15 * MiB)}</w:t></w:r></w:p>`), declaredSize: 100_000 } } }),
    kind: "docx",
  }),
  "pdf-50-pages": () => ({ bytes: makePdf(numberedPages(50, `${LESSON} `.repeat(30))), kind: "pdf" }),
  "pdf-2000-pages": () => ({ bytes: makePdf(numberedPages(2000)), kind: "pdf" }),
  "pdf-dense-single-page-8MiB": () => ({ bytes: densePdfPage(8), kind: "pdf" }),
  "pdf-dense-deadline-500ms": () => ({ bytes: densePdfPage(8), kind: "pdf", deadlineMs: 500 }),
  "docx-18MiB-deadline-200ms": () => ({ bytes: bigDocx(18), kind: "docx", deadlineMs: 200 }),
};

const make = scenarios[scenario];
if (!make) {
  console.error(`unknown scenario; choose one of: ${Object.keys(scenarios).join(", ")}`);
  process.exit(2);
}
const { bytes, kind, deadlineMs } = make();
const rssBefore = process.memoryUsage().rss;

let last = performance.now();
let maxGap = 0;
const ticker = setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - last);
  last = now;
}, 1);

const started = performance.now();
let outcome = "ok";
let detail: Record<string, unknown> = {};
try {
  const result = await extractDocument(bytes, kind, deadlineMs ? { deadlineMs } : {});
  detail = { chars: result.text.length, pages: result.page_count, totalPages: result.total_pages, truncated: result.is_truncated };
} catch (error) {
  outcome = (error as { code?: string }).code ?? "unexpected";
}
const elapsed = performance.now() - started;
await new Promise((resolve) => setTimeout(resolve, 5));
clearInterval(ticker);

process.stdout.write(
  `${JSON.stringify({
    scenario,
    deadlineMs: deadlineMs ?? 20_000,
    inputMiB: Number((bytes.length / MiB).toFixed(2)),
    outcome,
    ...detail,
    ms: Math.round(elapsed),
    maxEventLoopStallMs: Math.round(maxGap),
    rssBeforeMiB: Math.round(rssBefore / MiB),
    peakRssMiB: Math.round((process.resourceUsage().maxRSS * 1024) / MiB),
  })}\n`,
);
