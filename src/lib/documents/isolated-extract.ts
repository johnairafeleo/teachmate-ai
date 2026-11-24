import { Worker, type ResourceLimits } from "node:worker_threads";

import { ExtractionError } from "./errors.ts";
import type { ExtractionResult } from "./extract.ts";
import { EXTRACTION_LIMITS } from "./limits.ts";
import { workerResponseSchema, type WorkerRequest } from "./worker/protocol.ts";

/**
 * CPU isolation for document extraction (node:worker_threads).
 *
 * Every extraction runs in a fresh, single-use worker thread:
 *  - Hard deadline from the parent: when it expires the worker is TERMINATED (V8 stops the thread
 *    even inside a synchronous loop), so a pathological file cannot keep using CPU.
 *  - V8 heap limits per worker; running out of heap ends only that worker (LIMITS_EXCEEDED).
 *  - A process-level RSS watchdog. V8 heap limits do NOT cover ArrayBuffers (external memory),
 *    and PDF.js decodes a compressed content stream into one growing ArrayBuffer: a 1.5 MiB PDF
 *    reached +3.1 GiB RSS before the deadline (TASK 005.7.1). The parent samples
 *    process.memoryUsage.rss() and terminates the worker past either ceiling (MEMORY_LIMITS).
 *    Workers share the process, so the sample covers them; it also counts other requests on the
 *    same instance, which is intended: the instance's total is what the platform limits.
 *  - Memory attribution (TASK 005.7.5/005.7.6): RSS cannot say WHO grew. The parent also polls
 *    worker.getHeapStatistics() (used_heap_size + external_memory: the worker isolate's own heap
 *    and ArrayBuffers) and, when the watchdog fires, classifies the kill: the worker itself
 *    reached documentAttributionBytes → ExtractionError LIMITS_EXCEEDED (permanent, the file's
 *    fault); otherwise, or with no sample → MemoryPressureError (shared pressure, retryable; the
 *    service bounds the retries). Polling never delays or disables the RSS watchdog.
 *  - No credentials: empty environment, no shared clients; only bytes + plain parameters go in.
 *  - The input buffer is transferred (not copied) when the caller allows it.
 *  - Exactly one reply, validated with Zod; anything else is a protocol error.
 *  - A per-process concurrency limit (slots), so one function instance never runs more parallel
 *    extractions than it has CPU for. Callers acquire a slot BEFORE claiming a document, so "busy"
 *    stays a retryable condition instead of a failed document.
 * Workers are never reused: no PDF.js state survives between documents.
 */

export const WORKER_LIMITS = {
  /**
   * Parallel extraction workers per server process. Vercel Hobby has 1 vCPU per instance and
   * Fluid compute shares an instance between requests, so a second CPU-bound worker would only
   * split that CPU and double the memory at risk. Extra requests get retryable SERVER_BUSY.
   */
  maxConcurrentWorkers: 1,
  /** Extra time after the in-worker cooperative deadline before the parent terminates it. */
  hardTimeoutGraceMs: 1_500,
  /** Measured peaks (TASK 005.3): ~60 MiB for an 18 MiB document.xml, ~50 MiB for a dense PDF page. */
  resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 } satisfies ResourceLimits,
} as const;

const MiB = 1024 * 1024;

/**
 * Process memory budget (RSS) for extraction. Vercel Hobby functions have 2 GB (documented,
 * not configurable). These limits leave room below that for sampling lag, PDF.js's buffer
 * doubling (one allocation can double a buffer between samples) and the rest of the server.
 * Locally measured (Windows, Node 24; TASK 005.7.1/005.7.2): ordinary documents grow RSS by
 * ~90–160 MiB; the watchdog stops a 1 GiB-decoding PDF at ~+520 MiB.
 */
export const MEMORY_LIMITS = {
  /**
   * Refuse to START an extraction above this RSS (retryable SERVER_BUSY; nothing is claimed).
   * = absolute − growth, so a worker admitted at the ceiling meets both limits at the same point.
   */
  admissionRssBytes: 768 * MiB,
  /** Terminate the worker when process RSS passes this, whatever the baseline. */
  absoluteRssBytes: 1280 * MiB,
  /** Terminate the worker when RSS grows this much above its value when the worker started. */
  maxGrowthBytes: 512 * MiB,
  /** Sampling interval; a separate thread, so the parent's timer runs while the worker computes. */
  sampleIntervalMs: 20,
  /**
   * A watchdog kill is the DOCUMENT's fault when the worker's own memory (peak of
   * used_heap_size + external_memory during this extraction) reached this. Measured locally
   * (TASK 005.7.5): ordinary documents peak at 28–160 MiB; a 1 GiB-decoding PDF passes 256 MiB
   * ~0.7 s before the 512 MiB growth limit fires.
   */
  documentAttributionBytes: 256 * MiB,
  /** worker.getHeapStatistics() polling interval (one call in flight at a time). */
  workerStatsIntervalMs: 20,
} as const;

export type MemoryLimits = {
  admissionRssBytes: number;
  absoluteRssBytes: number;
  maxGrowthBytes: number;
  sampleIntervalMs: number;
  /** Tests only: replaces process.memoryUsage.rss(). */
  readRss?: () => number;
  documentAttributionBytes?: number;
  workerStatsIntervalMs?: number;
  /** Tests only: replaces the worker-stats reader (used_heap_size + external_memory). */
  readWorkerBytes?: (worker: Worker) => Promise<number>;
};

/** How the worker's own memory was known when the watchdog fired. */
export type MemoryAttribution = "measured" | "unavailable";

/**
 * The watchdog terminated the worker, but the worker's own memory stayed below
 * documentAttributionBytes (or could not be measured): the process as a whole was under
 * pressure, so the DOCUMENT is not to blame. Retryable; callers must bound the retries.
 * Carries no document data.
 */
export class MemoryPressureError extends Error {
  readonly trigger: "process_memory" | "memory_growth";
  readonly attribution: MemoryAttribution;
  /** Peak worker used_heap_size + external_memory seen, or null when no sample arrived. */
  readonly workerPeakBytes: number | null;
  constructor(trigger: "process_memory" | "memory_growth", attribution: MemoryAttribution, workerPeakBytes: number | null) {
    super("Server memory pressure: extraction stopped.");
    this.name = "MemoryPressureError";
    this.trigger = trigger;
    this.attribution = attribution;
    this.workerPeakBytes = workerPeakBytes;
  }
}

const defaultReadWorkerBytes = async (worker: Worker): Promise<number> => {
  // Node >= 22.16 / 24 runtime API; not yet in the installed @types/node.
  const withStats = worker as Worker & { getHeapStatistics(): Promise<{ used_heap_size: number; external_memory: number }> };
  const stats = await withStats.getHeapStatistics();
  return stats.used_heap_size + stats.external_memory;
};

const readRssOf = (limits: MemoryLimits) => (limits.readRss ?? (() => process.memoryUsage.rss()))();

/**
 * Admission check: is there room to start an extraction now? Callers that claim documents check
 * this BEFORE the claim, so a busy instance leaves the document retryable.
 */
export function hasMemoryForExtraction(limits: MemoryLimits = MEMORY_LIMITS): { ok: boolean; rssBytes: number } {
  const rssBytes = readRssOf(limits);
  return { ok: rssBytes <= limits.admissionRssBytes, rssBytes };
}

// ------------------------------------------------------------------ slots

let active = 0;
const waiters: (() => void)[] = [];

export type ExtractionSlot = { release: () => void };

/**
 * Wait (up to `waitMs`) for a free extraction slot. Resolves null when none frees up in time or
 * the signal aborts — the caller should report a retryable "busy" state.
 */
export function acquireExtractionSlot(waitMs: number, signal?: AbortSignal, limit: number = WORKER_LIMITS.maxConcurrentWorkers): Promise<ExtractionSlot | null> {
  const grant = (): ExtractionSlot => {
    active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        active -= 1;
        waiters.shift()?.();
      },
    };
  };
  if (active < limit && waiters.length === 0) return Promise.resolve(grant());
  if (signal?.aborted || waitMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", giveUp);
      resolve(grant());
    };
    const giveUp = () => {
      clearTimeout(timer);
      const index = waiters.indexOf(wake);
      if (index !== -1) waiters.splice(index, 1);
      resolve(null);
    };
    const timer = setTimeout(giveUp, waitMs);
    signal?.addEventListener("abort", giveUp, { once: true });
    waiters.push(wake);
  });
}

/** For tests and diagnostics. */
export const extractionSlotsInUse = () => active;

// ------------------------------------------------------------------ extraction

export type IsolatedExtractOptions = {
  deadlineMs?: number;
  mimeType?: string | null;
  /** Aborting terminates the worker immediately. */
  signal?: AbortSignal;
  /** Hand the caller's buffer to the worker instead of copying it (the caller's view is detached). */
  transfer?: boolean;
  /** A slot already held by the caller; otherwise one is acquired (waiting within the deadline). */
  slot?: ExtractionSlot;
  /** Tests only: a fault-injection worker. Production always uses ./worker/extract-worker.ts. */
  workerUrl?: URL;
  /** Tests only: tighter limits to provoke out-of-memory. */
  resourceLimits?: ResourceLimits;
  /** Tests only: other memory ceilings or a fake RSS reader. Production uses MEMORY_LIMITS. */
  memory?: MemoryLimits;
  /**
   * The caller already checked admission BEFORE committing to this extraction (the document
   * service checks it before claiming a document). Then no second check runs here: once a
   * document is `processing` there is no way back to `uploaded`, so refusing at this point would
   * turn temporary memory pressure into a permanent failure. The RSS watchdog still applies.
   */
  admissionChecked?: boolean;
};

export async function extractDocumentIsolated(input: Uint8Array, kind: string, options: IsolatedExtractOptions = {}): Promise<ExtractionResult> {
  // Cheap checks in the parent: no worker for inputs that can never be valid.
  if (kind !== "pdf" && kind !== "docx") throw new ExtractionError("UNSUPPORTED_TYPE");
  if (!(input instanceof Uint8Array)) throw new ExtractionError("UNSUPPORTED_TYPE");
  if (input.byteLength === 0) throw new ExtractionError("EMPTY_FILE");
  if (input.byteLength > EXTRACTION_LIMITS.maxInputBytes) throw new ExtractionError("FILE_TOO_LARGE");

  const deadlineMs = Math.max(1, options.deadlineMs ?? EXTRACTION_LIMITS.defaultDeadlineMs);
  const deadlineAt = Date.now() + deadlineMs;
  const slot = options.slot ?? (await acquireExtractionSlot(deadlineMs, options.signal));
  if (!slot) throw new ExtractionError("TIMEOUT", options.signal?.aborted ? "aborted" : "worker_busy");
  try {
    // Direct callers: admission here (no worker is started). The document service checks it
    // before its claim and passes admissionChecked (see the option).
    if (!options.admissionChecked && !hasMemoryForExtraction(options.memory).ok) throw new ExtractionError("TIMEOUT", "memory_busy");
    const remaining = Math.max(1, deadlineAt - Date.now());
    return await runWorker(input, kind, remaining, options);
  } finally {
    if (!options.slot) slot.release(); // a caller-provided slot is released by the caller
  }
}

function ownedBuffer(input: Uint8Array, transfer: boolean): ArrayBuffer {
  const buffer = input.buffer;
  if (transfer && buffer instanceof ArrayBuffer && input.byteOffset === 0 && input.byteLength === buffer.byteLength) return buffer;
  return input.slice().buffer as ArrayBuffer; // one bounded copy (≤ 10 MiB)
}

function runWorker(input: Uint8Array, kind: "pdf" | "docx", remainingMs: number, options: IsolatedExtractOptions): Promise<ExtractionResult> {
  return new Promise<ExtractionResult>((resolve, reject) => {
    const workerOptions = {
      env: { NODE_ENV: process.env.NODE_ENV ?? "production" }, // no secrets, no Supabase keys
      execArgv: [],
      resourceLimits: options.resourceLimits ?? WORKER_LIMITS.resourceLimits,
      stdout: true, // swallow any library output instead of mixing it into server logs
      stderr: true,
    };
    let worker: Worker;
    try {
      worker = options.workerUrl
        ? new Worker(options.workerUrl, workerOptions)
        : new Worker(new URL("./worker/extract-worker.ts", import.meta.url), workerOptions);
    } catch {
      reject(new ExtractionError("INTERNAL_ERROR", "worker_start"));
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();

    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      clearTimeout(statsTimer);
      worker.off("online", startStats);
      options.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners("message");
      worker.removeAllListeners("exit");
      worker.on("error", () => {}); // late errors from a terminating worker are irrelevant
      // Wait for the thread to be gone before settling, so a released slot means a free CPU.
      worker.terminate().then(outcome, outcome);
    };

    const timer = setTimeout(() => finish(() => reject(new ExtractionError("TIMEOUT", "worker_timeout"))), remainingMs + WORKER_LIMITS.hardTimeoutGraceMs);
    const onAbort = () => finish(() => reject(new ExtractionError("TIMEOUT", "aborted")));

    // Worker's own memory (attribution only). Starts after "online" (calls before it reject);
    // one call in flight at a time; a rejected or late call never affects the watchdog below.
    const memory: MemoryLimits = options.memory ?? MEMORY_LIMITS;
    const readWorkerBytes = memory.readWorkerBytes ?? defaultReadWorkerBytes;
    const statsInterval = memory.workerStatsIntervalMs ?? MEMORY_LIMITS.workerStatsIntervalMs;
    let workerPeakBytes: number | null = null;
    let statsTimer: NodeJS.Timeout | undefined;
    const pollStats = () => {
      if (settled) return;
      let pending: Promise<number>;
      try {
        pending = readWorkerBytes(worker);
      } catch {
        statsTimer = setTimeout(pollStats, statsInterval);
        return;
      }
      pending.then(
        (bytes) => {
          if (settled) return;
          if (Number.isFinite(bytes) && bytes >= 0) workerPeakBytes = Math.max(workerPeakBytes ?? 0, bytes);
          statsTimer = setTimeout(pollStats, statsInterval);
        },
        () => {
          // Statistics unavailable (e.g. ERR_WORKER_NOT_RUNNING while exiting): keep the last
          // peak and try again; the RSS watchdog is unaffected.
          if (!settled) statsTimer = setTimeout(pollStats, statsInterval);
        },
      );
    };
    const startStats = () => pollStats();
    worker.once("online", startStats);

    // RSS watchdog: the baseline is the process's real current RSS, never assumed to be zero.
    // Thresholds and termination are unchanged; only the classification uses the worker stats.
    const baseline = readRssOf(memory);
    const attributionBytes = memory.documentAttributionBytes ?? MEMORY_LIMITS.documentAttributionBytes;
    const memoryKill = (trigger: "process_memory" | "memory_growth") => {
      const peak = workerPeakBytes;
      if (peak !== null && peak >= attributionBytes) return () => reject(new ExtractionError("LIMITS_EXCEEDED", trigger));
      return () => reject(new MemoryPressureError(trigger, peak === null ? "unavailable" : "measured", peak));
    };
    const checkMemory = () => {
      const rss = readRssOf(memory);
      if (rss > memory.absoluteRssBytes) finish(memoryKill("process_memory"));
      else if (rss - baseline > memory.maxGrowthBytes) finish(memoryKill("memory_growth"));
    };
    const watchdog = setInterval(checkMemory, memory.sampleIntervalMs);
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    worker.once("message", (message: unknown) => {
      const parsed = workerResponseSchema.safeParse(message);
      if (!parsed.success) return finish(() => reject(new ExtractionError("INTERNAL_ERROR", "worker_protocol")));
      const reply = parsed.data;
      if (reply.ok) return finish(() => resolve(reply.result));
      finish(() => reject(new ExtractionError(reply.code, reply.reason)));
    });
    worker.once("error", (error: Error & { code?: string }) => {
      const memory = error?.code === "ERR_WORKER_OUT_OF_MEMORY";
      finish(() => reject(new ExtractionError(memory ? "LIMITS_EXCEEDED" : "INTERNAL_ERROR", memory ? "worker_memory" : "worker_crash")));
    });
    worker.once("exit", () => finish(() => reject(new ExtractionError("INTERNAL_ERROR", "worker_exit"))));

    const request: WorkerRequest = {
      bytes: ownedBuffer(input, options.transfer === true),
      kind,
      mimeType: options.mimeType?.trim() ? options.mimeType : null,
      deadlineMs: remainingMs,
    };
    try {
      worker.postMessage(request, [request.bytes]);
    } catch {
      finish(() => reject(new ExtractionError("INTERNAL_ERROR", "worker_start")));
    }
  });
}
