"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CirclePlus, Info } from "lucide-react";

import { getPresentationDocumentsAction, processDocumentAction } from "@/app/dashboard/create/actions";
import { DocumentStatusList, type StatusRow } from "@/components/create/upload/document-status-list";
import { UPLOAD_MESSAGES, uploadToStorage } from "@/components/create/upload/storage-upload";
import { needsPolling, phaseFromProcessResult, phaseFromStatusView, runSummary, type FileProgress } from "@/components/create/upload/upload-state";
import { buttonVariants } from "@/components/ui/button";
import { getPublicEnv } from "@/lib/env/public";
import { checkFile } from "@/lib/file-validation";
import { GRADE_LEVELS, LANGUAGES, SUBJECTS, THEMES, labelFor } from "@/lib/presentation-options";
import type { PresentationDocumentsView } from "@/lib/server/documents/service";
import { createClient } from "@/lib/supabase/client";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40;

type Override = Partial<Pick<FileProgress, "phase" | "uploadedBytes" | "error" | "retry">>;

/**
 * Live view of a presentation's documents. The initial data is loaded server-side (DAL + RLS);
 * afterwards the client refreshes through the same Server Action. Local overrides only describe
 * work this tab is doing right now (uploading / processing) and are dropped on every refresh,
 * so the server's status always wins.
 */
export function PresentationStatusView({ initial }: { initial: PresentationDocumentsView }) {
  const [view, setView] = useState(initial);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [inFlight, setInFlight] = useState(0);

  const setOverride = (key: string, patch: Override | null) =>
    setOverrides((current) => {
      const next = { ...current };
      if (patch) next[key] = { ...next[key], ...patch };
      else delete next[key];
      return next;
    });

  const refresh = useCallback(async () => {
    try {
      const result = await getPresentationDocumentsAction(view.presentationId);
      if (result.ok) setView(result.data);
    } catch {
      // keep the last known state; the next poll or action refreshes it
    }
  }, [view.presentationId]);

  const rows: StatusRow[] = view.documents.map((doc) => ({
    key: doc.documentId,
    name: doc.fileName,
    size: doc.fileSize,
    fileType: doc.fileType,
    extract: doc.extract,
    uploadedBytes: 0,
    ...phaseFromStatusView(doc),
    ...overrides[doc.documentId],
  }));

  async function process(key: string) {
    setOverride(key, { phase: "processing", error: undefined, retry: null });
    try {
      const result = await processDocumentAction(key);
      setOverride(key, phaseFromProcessResult(result));
    } catch {
      setOverride(key, { phase: "needs_retry", retry: "process", error: { code: "INTERNAL_ERROR", message: "We couldn’t reach the server. Check your connection and try again.", retryable: true } });
    }
    await refresh();
    setOverride(key, null);
  }

  async function retry(key: string) {
    setInFlight((n) => n + 1);
    try {
      await process(key);
    } finally {
      setInFlight((n) => n - 1);
    }
  }

  async function reupload(key: string, file: File) {
    const doc = view.documents.find((d) => d.documentId === key);
    if (!doc?.upload) return;
    setInFlight((n) => n + 1);
    try {
      // Same client pre-checks as the form; the server validates the stored bytes again.
      const check = await checkFile(file);
      if ("error" in check || check.kind !== doc.fileType) {
        setOverride(key, {
          error: { code: "TYPE_MISMATCH", message: "error" in check ? check.error : `Choose a ${doc.fileType.toUpperCase()} file for this item.`, retryable: true },
        });
        return;
      }
      setOverride(key, { phase: "uploading", uploadedBytes: 0, error: undefined, retry: null });
      const { data } = await createClient().auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setOverride(key, { phase: "upload_failed", retry: "upload", error: { code: "UNAUTHENTICATED", message: UPLOAD_MESSAGES.SESSION, retryable: true } });
        return;
      }
      const env = getPublicEnv();
      const outcome = await uploadToStorage({
        supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        accessToken,
        bucket: "source-materials",
        path: doc.upload.storagePath,
        file,
        contentType: doc.upload.contentType,
        onProgress: (loaded) => setOverride(key, { uploadedBytes: Math.min(loaded, doc.fileSize) }),
      });
      if (outcome.kind === "failed") {
        setOverride(key, { phase: "upload_failed", retry: outcome.retryable ? "upload" : null, error: { code: "STORAGE_UNAVAILABLE", message: UPLOAD_MESSAGES[outcome.code], retryable: outcome.retryable } });
        return;
      }
      await process(key);
    } finally {
      setInFlight((n) => n - 1);
    }
  }

  // Bounded polling while the server is still reading a file.
  const polling = needsPolling(rows) && inFlight === 0;
  useEffect(() => {
    if (!polling) return;
    let polls = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled || polls >= MAX_POLLS) return;
      polls += 1;
      await refresh();
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [polling, refresh]);

  const theme = THEMES.find((t) => t.value === view.settings.theme);
  const readyCount = rows.filter((row) => row.phase === "ready").length;

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="settings-heading" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        <h2 id="settings-heading" className="mb-4 text-lg font-semibold">
          Presentation settings
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <Setting label="Grade" value={labelFor(GRADE_LEVELS, String(view.settings.grade))} />
          <Setting label="Subject" value={labelFor(SUBJECTS, view.settings.subject)} />
          <Setting label="Language" value={labelFor(LANGUAGES, view.settings.language)} />
          <Setting label="Slides" value={String(view.settings.slideCount)} />
          <Setting label="Theme" value={theme?.label ?? view.settings.theme} />
          <Setting label="Source" value={view.generationMode === "materials" ? "Learning materials" : "Topic"} />
        </dl>
      </section>

      <section aria-labelledby="materials-heading" className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 id="materials-heading" className="text-lg font-semibold">
            Learning materials
          </h2>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {rows.length === 0 ? "No files were added to this presentation." : runSummary(rows)}
          </p>
        </div>
        {rows.length > 0 ? <DocumentStatusList rows={rows} onRetry={(key) => void retry(key)} onReupload={(key, file) => void reupload(key, file)} disabled={inFlight > 0} labelledBy="materials-heading" /> : null}
      </section>

      <p className="flex gap-2 rounded-xl bg-secondary p-3 text-sm text-secondary-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {readyCount > 0
          ? "The text from your ready files will be the source for your slides. Slide generation isn’t connected yet."
          : "Slides can be generated once at least one file is ready. Slide generation isn’t connected yet."}
      </p>

      <div>
        <Link href="/dashboard/create?mode=materials" className={buttonVariants({ variant: "outline", className: "h-10 px-4" })}>
          <CirclePlus data-icon="inline-start" />
          Create another presentation
        </Link>
      </div>
    </div>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
