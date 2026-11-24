"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

import { createMaterialsDraftAction, getPresentationDocumentsAction, processDocumentAction } from "@/app/dashboard/create/actions";
import type { UploadTarget } from "@/lib/server/documents/service";
import { getPublicEnv } from "@/lib/env/public";
import { createClient } from "@/lib/supabase/client";

import { UPLOAD_MESSAGES, uploadToStorage } from "./storage-upload";
import { canStartRun, INITIAL_RUN, isRunBusy, mimeHint, needsPolling, uploadReducer, type SafeMessage, type UploadRun } from "./upload-state";

export type DraftSettings = { title: string; grade: string; subject: string; language: string; theme: string; slideCount: string };
export type SelectedUpload = { key: string; file: File; kind: "pdf" | "docx" };

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes, then the teacher can check the status page

const message = (code: string, text: string, retryable: boolean): SafeMessage => ({ code: code as SafeMessage["code"], message: text, retryable });
const NETWORK_ERROR = message("INTERNAL_ERROR", "We couldn’t reach the server. Check your connection and try again.", true);

/**
 * Orchestrates draft → direct upload → server processing for the materials form.
 * Every outcome shown comes from Storage or the server; nothing is marked successful locally.
 */
export function useMaterialsUpload() {
  const [run, dispatch] = useReducer(uploadReducer, INITIAL_RUN);
  const runRef = useRef<UploadRun>(run);
  const startingRef = useRef(false); // synchronous duplicate-submit guard (state updates are async)
  const files = useRef(new Map<string, { file: File; target: UploadTarget }>());

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const processOne = useCallback(async (key: string) => {
    const entry = files.current.get(key);
    if (!entry) return;
    dispatch({ type: "process_started", key });
    try {
      const result = await processDocumentAction(entry.target.documentId);
      dispatch({ type: "process_result", key, result });
    } catch {
      dispatch({ type: "process_result", key, result: { ok: false, error: NETWORK_ERROR } });
    }
  }, []);

  const uploadOne = useCallback(
    async (key: string) => {
      const entry = files.current.get(key);
      if (!entry) return;
      dispatch({ type: "upload_started", key });
      const { data } = await createClient().auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        dispatch({ type: "upload_failed", key, error: message("UNAUTHENTICATED", UPLOAD_MESSAGES.SESSION, true) });
        return;
      }
      const env = getPublicEnv();
      const outcome = await uploadToStorage({
        supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        accessToken,
        bucket: "source-materials",
        path: entry.target.storagePath,
        file: entry.file,
        contentType: entry.target.contentType,
        onProgress: (loaded) => dispatch({ type: "upload_progress", key, loaded }),
      });
      if (outcome.kind === "failed") {
        dispatch({ type: "upload_failed", key, error: message(outcome.code, UPLOAD_MESSAGES[outcome.code], outcome.retryable) });
        return;
      }
      dispatch({ type: "upload_finished", key });
      await processOne(key); // "maybe_exists" too: the server verifies what is really stored
    },
    [processOne],
  );

  const start = useCallback(
    async (settings: DraftSettings, selected: SelectedUpload[]) => {
      if (startingRef.current || !canStartRun(runRef.current) || selected.length === 0) return;
      startingRef.current = true;
      try {
        dispatch({ type: "start", files: selected.map(({ key, file }) => ({ key, name: file.name, size: file.size })) });
        let result;
        try {
          result = await createMaterialsDraftAction({
            ...settings,
            files: selected.map(({ file, kind }) => ({ name: file.name, size: file.size, mimeType: mimeHint(kind, file.type) })),
          });
        } catch {
          dispatch({ type: "draft_failed", error: NETWORK_ERROR });
          return;
        }
        if (!result.ok) {
          dispatch({ type: "draft_failed", error: result.error, fields: result.error.fields });
          return;
        }
        files.current.clear();
        result.data.uploads.forEach((target, index) => files.current.set(selected[index].key, { file: selected[index].file, target }));
        dispatch({ type: "draft_created", presentationId: result.data.presentationId, documentIds: result.data.uploads.map((u) => u.documentId) });
        await Promise.all(selected.map(({ key }) => uploadOne(key)));
      } finally {
        startingRef.current = false;
      }
    },
    [uploadOne],
  );

  const retry = useCallback(
    async (key: string) => {
      const file = runRef.current.files.find((f) => f.key === key);
      if (!file || !file.retry) return;
      if (file.retry === "upload") await uploadOne(key);
      else await processOne(key);
    },
    [processOne, uploadOne],
  );

  // Bounded polling while the server is still processing something.
  const polling = run.phase === "active" && needsPolling(run.files);
  useEffect(() => {
    if (!polling || !run.presentationId) return;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || polls >= MAX_POLLS) return;
      polls += 1;
      try {
        const status = await getPresentationDocumentsAction(run.presentationId);
        if (!cancelled && status.ok) dispatch({ type: "status_sync", documents: status.data.documents });
      } catch {
        // transient; try again on the next tick
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [polling, run.presentationId]);

  // Warn before leaving while bytes are in flight or the server is working.
  const busy = isRunBusy(run);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const reset = useCallback(() => {
    files.current.clear();
    dispatch({ type: "reset" });
  }, []);

  return { run, start, retry, reset, busy };
}
