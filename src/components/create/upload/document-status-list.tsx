"use client";

import { useRef, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Clock, FileText, LoaderCircle, RefreshCw, RotateCcw, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { FilePhase, FileProgress } from "./upload-state";

export type StatusRow = Pick<FileProgress, "key" | "name" | "size" | "phase" | "uploadedBytes" | "error" | "retry"> & {
  /** Present when the server has extracted text. */
  extract?: { charCount: number; pageCount: number | null; isTruncated: boolean };
  fileType?: "pdf" | "docx";
};

const PHASE_UI: Record<FilePhase, { label: string; icon: typeof Clock; className: string }> = {
  waiting: { label: "Waiting", icon: Clock, className: "bg-muted text-muted-foreground" },
  uploading: { label: "Uploading", icon: UploadCloud, className: "bg-accent text-accent-foreground" },
  upload_failed: { label: "Upload failed", icon: CircleAlert, className: "bg-warning text-warning-foreground" },
  processing: { label: "Reading text", icon: LoaderCircle, className: "bg-accent text-accent-foreground" },
  ready: { label: "Ready", icon: CircleCheck, className: "bg-success text-success-foreground" },
  failed: { label: "Failed", icon: CircleAlert, className: "bg-destructive/10 text-destructive" },
  needs_retry: { label: "Retry available", icon: RefreshCw, className: "bg-warning text-warning-foreground" },
};

type DocumentStatusListProps = {
  rows: StatusRow[];
  /** Retry the server step (processing) or a re-upload of a file still held in memory. */
  onRetry?: (key: string) => void;
  /** Status page only: choose the file again for a document still waiting for its upload. */
  onReupload?: (key: string, file: File) => void;
  disabled?: boolean;
  labelledBy?: string;
};

export function DocumentStatusList({ rows, onRetry, onReupload, disabled, labelledBy }: DocumentStatusListProps) {
  return (
    <ul className="flex flex-col gap-3" aria-labelledby={labelledBy}>
      {rows.map((row) => (
        <DocumentStatusItem key={row.key} row={row} onRetry={onRetry} onReupload={onReupload} disabled={disabled} />
      ))}
    </ul>
  );
}

function DocumentStatusItem({ row, onRetry, onReupload, disabled }: { row: StatusRow } & Omit<DocumentStatusListProps, "rows" | "labelledBy">) {
  const ui = PHASE_UI[row.phase];
  const Icon = ui.icon;
  const percent = row.size > 0 ? Math.round((row.uploadedBytes / row.size) * 100) : 0;
  const messageId = `doc-${row.key}-message`;
  const inputRef = useRef<HTMLInputElement>(null);
  const label = row.phase === "uploading" ? `${ui.label} ${percent}%` : row.phase === "waiting" && onReupload && row.retry === "upload" ? "Waiting for upload" : ui.label;

  let action: ReactNode = null;
  if (row.retry === "process" && onRetry) {
    action = (
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onRetry(row.key)} aria-describedby={messageId}>
        <RotateCcw data-icon="inline-start" />
        Try again<span className="sr-only">: {row.name}</span>
      </Button>
    );
  } else if (row.retry === "upload" && onReupload) {
    action = (
      <>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept={row.fileType === "docx" ? ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" : ".pdf,application/pdf"}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onReupload(row.key, file);
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => inputRef.current?.click()} aria-describedby={messageId}>
          <UploadCloud data-icon="inline-start" />
          Upload this file again<span className="sr-only">: {row.name}</span>
        </Button>
      </>
    );
  } else if (row.retry === "upload" && onRetry) {
    action = (
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onRetry(row.key)} aria-describedby={messageId}>
        <RotateCcw data-icon="inline-start" />
        Retry upload<span className="sr-only">: {row.name}</span>
      </Button>
    );
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <FileText className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={row.name}>
            {row.name}
          </p>
          <p className="text-sm text-muted-foreground">{formatFileSize(row.size)}</p>
        </div>
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", ui.className)}>
          <Icon className={cn("size-3.5", row.phase === "processing" && "motion-safe:animate-spin")} aria-hidden="true" />
          {label}
        </span>
      </div>

      {row.phase === "uploading" ? (
        <div
          role="progressbar"
          aria-label={`Uploading ${row.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      ) : null}

      <div id={messageId} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {row.phase === "ready" && row.extract ? (
          <p className="text-sm text-success-foreground">
            Text extracted: {row.extract.charCount.toLocaleString("en-PH")} characters
            {row.extract.pageCount !== null ? `, ${row.extract.pageCount} page${row.extract.pageCount === 1 ? "" : "s"}` : ""}.
            {row.extract.isTruncated ? " Only the first part was used (file was very long)." : ""}
          </p>
        ) : row.phase === "ready" ? (
          <p className="text-sm text-success-foreground">Text extracted.</p>
        ) : row.phase === "processing" ? (
          <p className="text-sm text-muted-foreground">Checking the file and reading its text…</p>
        ) : row.error ? (
          <p className={cn("flex gap-1.5 text-sm", row.phase === "failed" ? "text-destructive" : "text-warning-foreground")}>
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {row.error.message}
          </p>
        ) : row.phase === "waiting" && row.retry === "upload" ? (
          <p className="text-sm text-muted-foreground">This file was registered, but its upload didn’t finish.</p>
        ) : row.phase === "needs_retry" ? (
          <p className="text-sm text-warning-foreground">This file is uploaded but hasn’t been read yet.</p>
        ) : (
          <span />
        )}
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </li>
  );
}
