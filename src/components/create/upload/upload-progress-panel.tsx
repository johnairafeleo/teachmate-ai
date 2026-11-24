"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ArrowRight, Info } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

import { DocumentStatusList } from "./document-status-list";
import { isTerminal, runSummary, type UploadRun } from "./upload-state";

type UploadProgressPanelProps = {
  run: UploadRun;
  busy: boolean;
  onRetry: (key: string) => void;
  onReset: () => void;
};

/** Per-file progress for the materials workflow. Every state shown comes from Storage or the server. */
export function UploadProgressPanel({ run, busy, onRetry, onReset }: UploadProgressPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const done = run.files.length > 0 && run.files.every(isTerminal);
  const anyReady = run.files.some((file) => file.phase === "ready");
  const title = run.phase === "creating" ? "Preparing your upload…" : done ? (anyReady ? "Your materials are ready" : "We couldn’t use these files") : "Uploading your materials";

  return (
    <section aria-labelledby="upload-progress-heading" className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 id="upload-progress-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          {title}
        </h2>
        {/* One polite summary instead of announcing every progress tick. */}
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {run.phase === "creating" ? "Registering your files…" : runSummary(run.files)}
        </p>
      </div>

      {run.files.length > 0 ? <DocumentStatusList rows={run.files} onRetry={onRetry} disabled={run.phase !== "active"} labelledBy="upload-progress-heading" /> : null}

      {busy ? (
        <p className="flex gap-2 rounded-xl bg-secondary p-3 text-sm text-secondary-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Keep this page open until every file shows Ready or Failed.
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {run.presentationId ? (
          <Link href={`/dashboard/presentations/${run.presentationId}`} className={buttonVariants({ className: "h-10 px-4" })}>
            Open presentation status
            <ArrowRight data-icon="inline-end" />
          </Link>
        ) : null}
        {!busy && run.phase === "active" ? (
          <button type="button" onClick={onReset} className={buttonVariants({ variant: "ghost", className: "h-10 px-4" })}>
            Upload different files
          </button>
        ) : null}
      </div>
    </section>
  );
}
