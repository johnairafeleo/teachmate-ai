/**
 * TEST-ONLY fault-injection worker (never referenced by production code). The behaviour is
 * selected by the first bytes of the input:
 *   HANG        synchronous infinite loop (only termination can stop it)
 *   CRASH       uncaught exception
 *   EXIT        process.exit(3) without replying
 *   INVALID:n   protocol violations (several shapes)
 *   OOM         allocate until the heap limit
 *   SLOW:ms     busy-wait, then a valid reply
 *   PROBE       report what the worker can see (env keys, request keys) as a valid reply
 */
import { parentPort } from "node:worker_threads";

const port = parentPort!;

port.once("message", (request: { bytes: ArrayBuffer; kind: string; mimeType: string | null; deadlineMs: number }) => {
  const command = new TextDecoder().decode(new Uint8Array(request.bytes).slice(0, 32));
  const valid = (text: string) => ({ ok: true, result: { text, page_count: null, total_pages: null, is_truncated: false, extractor_version: "fault-worker" } });

  if (command.startsWith("HANG")) {
    for (;;) {
      // burn CPU forever
    }
  }
  if (command.startsWith("CRASH")) throw new Error("simulated crash");
  if (command.startsWith("EXIT")) process.exit(3);
  if (command.startsWith("OOM")) {
    const hoard: number[][] = [];
    for (;;) hoard.push(new Array(1_000_000).fill(Math.random()));
  }
  if (command.startsWith("INVALID:")) {
    const variant = Number(command.slice(8, 9));
    const replies: unknown[] = [
      "not an object",
      { ok: true, result: { text: 123 } },
      { ok: true, result: { ...valid("x").result, text: "x".repeat(100_001) } },
      { ok: true, result: { ...valid("x").result, page_count: 51 } },
      { ok: false, code: "SOMETHING_ELSE" },
      { ...valid("x"), extra: "field" },
      { ok: true, result: { ...valid("x").result, secret: "leak" } },
    ];
    port.postMessage(replies[variant] ?? null);
    return;
  }
  if (command.startsWith("SLOW:")) {
    const until = Date.now() + Number(command.slice(5).trim());
    while (Date.now() < until) {
      // busy-wait: occupies a CPU like a real extraction
    }
    port.postMessage(valid("slow"));
    return;
  }
  if (command.startsWith("PROBE")) {
    port.postMessage(valid(JSON.stringify({
      envKeys: Object.keys(process.env).sort(),
      requestKeys: Object.keys(request).sort(),
      bytesIsArrayBuffer: request.bytes instanceof ArrayBuffer,
      byteLength: request.bytes.byteLength,
    })));
    return;
  }
  port.postMessage(valid("noop"));
});
