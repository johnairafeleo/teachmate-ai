"use client";

import {
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";
import { CircleAlert, CloudUpload, FileText, LoaderCircle, X } from "lucide-react";

import { DROPZONE_ATTRIBUTE } from "@/components/create/early-drop-guard";
import { describedBy, fieldIds } from "@/components/create/form-field";
import type { FileSelection } from "@/components/create/use-file-selection";
import { Button } from "@/components/ui/button";
import { checkFile } from "@/lib/file-validation";
import { formatFileSize } from "@/lib/format";
import { UPLOAD_RULES } from "@/lib/presentation-options";
import { cn } from "@/lib/utils";

type FileDropzoneProps = {
  id: string;
  selection: FileSelection;
  error?: string;
};

const noopSubscribe = () => () => {};

/**
 * false in the server HTML and during hydration, true once React has attached event
 * handlers (and immediately on client-side navigation, where there is no hydration).
 */
function useIsHydrated() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

const hasFiles = (event: globalThis.DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

export function FileDropzone({ id, selection, error }: FileDropzoneProps) {
  const { files, messages } = selection;
  const inputRef = useRef<HTMLInputElement>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  /** Selections still running async content checks. */
  const pendingRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const hintId = useId();
  const ids = fieldIds(id);
  const isReady = useIsHydrated();
  const isFull = files.length >= UPLOAD_RULES.maxFiles;

  /**
   * Shared path for the file picker, drag-and-drop, and files held by the pre-hydration
   * guard. Content checks run first; the limit and duplicate checks happen in the reducer
   * against the latest state.
   */
  async function addFiles(fileList: FileList | readonly File[] | null) {
    const picked = fileList ? Array.from(fileList) : [];
    if (picked.length === 0) return;

    // Start fresh feedback for a new gesture, but keep messages from a selection still in flight.
    if (pendingRef.current === 0) selection.clearMessages();
    pendingRef.current += 1;
    try {
      const candidates = await Promise.all(
        picked.map(async (file) => ({ file, result: await checkFile(file) })),
      );
      selection.add(candidates);
    } finally {
      pendingRef.current -= 1;
    }
  }

  const takeEarlyDrops = useEffectEvent(() => {
    const buffer = window.__teachmateEarlyDrop;
    if (!buffer) return; // client-side navigation: the guard script never ran
    buffer.active = false;
    const early = buffer.files.splice(0);
    if (early.length > 0) void addFiles(early);
  });

  // Layout effect: runs in the same task as the hydration commit, so no drop event can
  // slip between "React handlers attached" and "guard switched off" and be handled twice.
  useLayoutEffect(() => {
    takeEarlyDrops();

    // After hydration, keep a stray drop outside the upload area from making the browser
    // open the file and abandon the form. Drops on the area itself are handled by React.
    function blockStrayDrop(event: globalThis.DragEvent) {
      if (!hasFiles(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`[${DROPZONE_ATTRIBUTE}]`)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    }
    document.addEventListener("dragover", blockStrayDrop);
    document.addEventListener("drop", blockStrayDrop);
    return () => {
      document.removeEventListener("dragover", blockStrayDrop);
      document.removeEventListener("drop", blockStrayDrop);
    };
  }, []);

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    // Always allow the drop so a full list still reports why nothing was added.
    event.preventDefault();
    setIsDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void addFiles(event.dataTransfer.files);
  }

  function handleRemove(fileId: string) {
    selection.remove(fileId);
    // Return focus to a stable control after the list item disappears
    // (next frame, so the button is re-enabled if the list was full).
    requestAnimationFrame(() => browseRef.current?.focus());
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        {...{ [DROPZONE_ATTRIBUTE]: "" }}
        aria-busy={isReady ? undefined : true}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
        }}
        onDrop={handleDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          isDragging && !isFull ? "border-primary bg-accent" : "border-input bg-muted/40",
          error && !isDragging && "border-destructive/60",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-14 items-center justify-center rounded-2xl transition-colors",
            isDragging && !isFull ? "bg-primary text-primary-foreground" : "bg-card text-primary shadow-sm",
          )}
        >
          {isReady ? (
            <CloudUpload className="size-7" />
          ) : (
            <LoaderCircle className="size-7 motion-safe:animate-spin" />
          )}
        </span>
        <div>
          <p className="font-semibold">
            {!isReady
              ? "Preparing upload area…"
              : isFull
                ? `File limit reached (${UPLOAD_RULES.maxFiles} of ${UPLOAD_RULES.maxFiles})`
                : isDragging
                  ? "Drop to add your files"
                  : "Drag and drop your files here"}
          </p>
          <p id={hintId} className="mt-1 text-sm text-muted-foreground">
            PDF or DOCX · up to {formatFileSize(UPLOAD_RULES.maxFileSizeBytes)} each · max {UPLOAD_RULES.maxFiles} files
          </p>
        </div>
        <Button
          ref={browseRef}
          id={id}
          type="button"
          variant="outline"
          className="h-10 bg-card px-4"
          disabled={!isReady || isFull}
          aria-labelledby={`${ids.label} ${id}`}
          aria-describedby={[hintId, describedBy(id, { hasDescription: true, error })].filter(Boolean).join(" ")}
          onClick={() => inputRef.current?.click()}
        >
          Browse files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UPLOAD_RULES.acceptAttribute}
          disabled={!isReady}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void addFiles(event.target.files);
            event.target.value = ""; // allow re-selecting the same file after removal
          }}
        />
      </div>

      <div role="alert" aria-live="assertive" className="flex flex-col gap-1.5 empty:hidden">
        {messages.map((message) => (
          <p key={message.id} className="flex items-start gap-1.5 text-sm font-medium text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {message.text}
          </p>
        ))}
      </div>

      {files.length > 0 ? (
        <ul aria-label="Selected files" className="flex flex-col gap-2">
          {files.map(({ id: fileId, file, kind }) => (
            <li key={fileId} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-10 shrink-0 flex-col items-center justify-center rounded-lg text-[0.6rem] font-bold",
                  kind === "pdf" ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700",
                )}
              >
                <FileText className="size-4" />
                {kind.toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={file.name}>
                  {file.name}
                </p>
                <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${file.name}`}
                onClick={() => handleRemove(fileId)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
