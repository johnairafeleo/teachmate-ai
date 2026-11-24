"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { CircleAlert, CircleCheck, FileUp, FlaskConical, Info, Lightbulb, LoaderCircle, Sparkles, UploadCloud, type LucideIcon } from "lucide-react";

import { ChoiceGroup } from "@/components/create/choice-group";
import { FileDropzone } from "@/components/create/file-dropzone";
import { describedBy, Field } from "@/components/create/form-field";
import { OptionSelect } from "@/components/create/option-select";
import { ThemePicker } from "@/components/create/theme-picker";
import { UploadProgressPanel } from "@/components/create/upload/upload-progress-panel";
import { validateTitle } from "@/components/create/upload/upload-state";
import { useMaterialsUpload } from "@/components/create/upload/use-materials-upload";
import { useFileSelection } from "@/components/create/use-file-selection";
import { SlidePreview } from "@/components/presentation/slide-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  GRADE_LEVELS,
  LANGUAGES,
  SLIDE_COUNTS,
  SUBJECTS,
  THEMES,
  labelFor,
} from "@/lib/presentation-options";
import type { GenerationMode } from "@/lib/types";
import { cn } from "@/lib/utils";

type LessonSettings = {
  grade: string;
  subject: string;
  language: string;
  slideCount: string;
  theme: string;
};

type FieldName = "topic" | "objectives" | "title" | "materials" | "grade" | "subject";
type FormErrors = Partial<Record<FieldName, string>>;
/** "not-connected": the form validated, but generation is not implemented in this phase. */
type SubmitStatus = "idle" | "not-connected";

const TOPIC_MAX = 150;
const TITLE_MAX = 200;
const OBJECTIVES_MAX = 600;
const GENERATION_NOTICE_ID = "generation-notice";

/**
 * Screen-reader text for the objectives counter. It only changes when a threshold
 * is crossed, so the live region speaks occasionally instead of on every keystroke.
 */
function objectivesAnnouncement(length: number): string {
  const remaining = OBJECTIVES_MAX - length;
  if (remaining < 0) return `Learning objectives are over the ${OBJECTIVES_MAX} character limit.`;
  if (remaining === 0) return "Learning objectives have reached the character limit.";
  if (remaining <= 25) return "Fewer than 25 characters remaining for learning objectives.";
  if (remaining <= 100) return "Fewer than 100 characters remaining for learning objectives.";
  return "";
}
const FIELD_ORDER: FieldName[] = ["topic", "objectives", "title", "materials", "grade", "subject"];

/** Server validation reports field paths (e.g. "files.0.name"); map them onto form fields. */
function fieldFromServerPath(path: string): FieldName | undefined {
  const head = path.split(".")[0];
  if (head === "title" || head === "grade" || head === "subject") return head;
  if (head === "files") return "materials";
  return undefined;
}
const SLIDE_COUNT_OPTIONS = SLIDE_COUNTS.map((count) => ({ value: count, label: count }));

const MODE_TABS: { value: GenerationMode; icon: LucideIcon; title: string; description: string }[] = [
  {
    value: "topic",
    icon: Lightbulb,
    title: "Create from Topic",
    description: "Describe your lesson and let AI draft the slides.",
  },
  {
    value: "materials",
    icon: FileUp,
    title: "Create from Learning Materials",
    description: "Upload a PDF or DOCX to build slides from your source.",
  },
];

export function CreatePresentationForm({ initialMode = "topic" }: { initialMode?: GenerationMode }) {
  const [mode, setMode] = useState<GenerationMode>(initialMode);
  const [title, setTitle] = useState("");
  const uploads = useMaterialsUpload();
  const { run } = uploads;
  const uploading = run.phase === "creating" || run.phase === "active";
  const [topic, setTopic] = useState("");
  const [objectives, setObjectives] = useState("");
  const fileSelection = useFileSelection();
  const { files } = fileSelection;
  const [settings, setSettings] = useState<LessonSettings>({
    grade: "",
    subject: "",
    language: "english",
    slideCount: "10",
    theme: THEMES[0].value,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState<SubmitStatus>("idle");
  // The "add a file" error disappears as soon as a file is present, however it was added.
  const materialsError = files.length > 0 ? undefined : errors.materials;

  function touch(field?: FieldName) {
    if (status !== "idle") setStatus("idle");
    if (field && errors[field]) {
      setErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  }

  function updateSetting<K extends keyof LessonSettings>(key: K, value: LessonSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    touch(key === "grade" || key === "subject" ? key : undefined);
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (mode === "topic") {
      const trimmed = topic.trim();
      if (!trimmed) next.topic = "Enter a lesson topic.";
      else if (trimmed.length < 3) next.topic = "Topic should be at least 3 characters.";
      else if (trimmed.length > TOPIC_MAX) next.topic = `Keep the topic to ${TOPIC_MAX} characters or fewer.`;
      if (objectives.length > OBJECTIVES_MAX) {
        next.objectives = `Keep objectives under ${OBJECTIVES_MAX} characters.`;
      }
    } else {
      const titleError = validateTitle(title);
      if (titleError) next.title = titleError;
      if (files.length === 0) next.materials = "Add at least one PDF or DOCX file.";
    }
    if (!settings.grade) next.grade = "Choose a grade level.";
    if (!settings.subject) next.subject = "Choose a subject.";
    return next;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploading) return; // duplicate-submit guard (the hook guards again synchronously)

    const nextErrors = validate();
    setErrors(nextErrors);

    const firstInvalid = FIELD_ORDER.find((field) => nextErrors[field]);
    if (firstInvalid) {
      setStatus("idle");
      focusField(firstInvalid);
      return;
    }

    if (mode === "topic") {
      // Development placeholder: AI generation is not connected in this phase.
      setStatus("not-connected");
      return;
    }

    await uploads.start(
      { title, grade: settings.grade, subject: settings.subject, language: settings.language, theme: settings.theme, slideCount: settings.slideCount },
      files.map((selected) => ({ key: selected.id, file: selected.file, kind: selected.kind })),
    );
  }

  // Draft-level failure from the server (quota, invalid input, session): back to the form.
  const serverFields = (run.formErrorFields ?? []).map(fieldFromServerPath).filter((field): field is FieldName => Boolean(field));
  const draftError = run.phase === "draft_failed" ? run.formError : undefined;
  const titleError = errors.title ?? (draftError && serverFields.includes("title") ? "Check the title and try again." : undefined);
  const firstServerField = FIELD_ORDER.find((field) => serverFields.includes(field));

  // After a failed draft, move focus to the field the server rejected, or to the error itself.
  useEffect(() => {
    if (run.phase !== "draft_failed") return;
    if (firstServerField) focusField(firstServerField);
    else document.getElementById("draft-error")?.focus();
  }, [run.phase, run.formError, firstServerField]);

  const theme = THEMES.find((option) => option.value === settings.theme) ?? THEMES[0];
  const previewTitle =
    mode === "topic"
      ? topic.trim() || "Your lesson title"
      : title.trim() || files[0]?.file.name.replace(/\.(pdf|docx)$/i, "") || "Your lesson title";

  return (
    <form noValidate onSubmit={handleSubmit} aria-busy={uploads.busy || undefined} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        {uploading ? (
          <UploadProgressPanel run={run} busy={uploads.busy} onRetry={(key) => void uploads.retry(key)} onReset={uploads.reset} />
        ) : (
        <>
        <Tabs.Root
          value={mode}
          onValueChange={(value) => {
            setMode(value as GenerationMode);
            setErrors({});
            touch();
          }}
          className="flex flex-col gap-6"
        >
          <Tabs.List aria-label="Generation mode" className="grid gap-3 sm:grid-cols-2">
            {MODE_TABS.map((tab) => (
              <Tabs.Tab
                key={tab.value}
                value={tab.value}
                className={cn(
                  "group flex items-start gap-3 rounded-2xl border-2 bg-card p-4 text-left transition-all outline-none",
                  "border-border hover:border-primary/40",
                  "focus-visible:ring-3 focus-visible:ring-ring/50",
                  "data-active:border-primary data-active:bg-accent/50 data-active:shadow-sm",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors group-data-active:bg-primary group-data-active:text-primary-foreground"
                >
                  <tab.icon className="size-5" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">{tab.title}</span>
                  <span className="text-sm text-muted-foreground">{tab.description}</span>
                </span>
              </Tabs.Tab>
            ))}
          </Tabs.List>

          <Tabs.Panel value="topic" className="outline-none">
            <FormSection step={1} title="What’s the lesson about?">
              <Field
                id="topic"
                label="Lesson topic"
                description="Be specific — e.g. “The water cycle” or “Mga Pangngalan”."
                error={errors.topic}
              >
                <Input
                  id="topic"
                  name="topic"
                  value={topic}
                  maxLength={TOPIC_MAX}
                  placeholder="e.g. Parts of a plant and their functions"
                  autoComplete="off"
                  aria-invalid={errors.topic ? true : undefined}
                  aria-describedby={describedBy("topic", { hasDescription: true, error: errors.topic })}
                  onChange={(event) => {
                    setTopic(event.target.value);
                    touch("topic");
                  }}
                  className="h-10 bg-card"
                />
              </Field>
              <Field
                id="objectives"
                label="Learning objectives"
                optional
                description="What should learners be able to do by the end of the lesson?"
                error={errors.objectives}
              >
                <Textarea
                  id="objectives"
                  name="objectives"
                  value={objectives}
                  rows={4}
                  placeholder={"e.g.\n• Identify the parts of a plant\n• Describe what each part does"}
                  aria-invalid={errors.objectives ? true : undefined}
                  aria-describedby={[
                    describedBy("objectives", { hasDescription: true, error: errors.objectives }),
                    "objectives-count",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onChange={(event) => {
                    setObjectives(event.target.value);
                    touch("objectives");
                  }}
                  className="min-h-28 bg-card"
                />
                {/* Visible count is read with the field description on focus, not live. */}
                <p id="objectives-count" className="text-right text-xs text-muted-foreground">
                  {objectives.length}/{OBJECTIVES_MAX}
                  <span className="sr-only"> characters used</span>
                </p>
                <p className="sr-only" aria-live="polite">
                  {objectivesAnnouncement(objectives.length)}
                </p>
              </Field>
            </FormSection>
          </Tabs.Panel>

          <Tabs.Panel value="materials" className="outline-none">
            <FormSection step={1} title="Upload your learning materials">
              <Field
                id="title"
                label="Presentation title"
                description="Shown on your dashboard and the first slide."
                error={titleError}
              >
                <Input
                  id="title"
                  name="title"
                  value={title}
                  maxLength={TITLE_MAX}
                  required
                  placeholder="e.g. Parts of a Plant"
                  autoComplete="off"
                  aria-invalid={titleError ? true : undefined}
                  aria-describedby={describedBy("title", { hasDescription: true, error: titleError })}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    touch("title");
                  }}
                  className="h-10 bg-card"
                />
              </Field>
              <Field
                id="materials"
                label="Learning materials"
                labelAs="legend"
                description="Modules, lesson plans, or readings. Slides will be based on this content."
                error={materialsError}
              >
                <FileDropzone id="materials" selection={fileSelection} error={materialsError} />
              </Field>
              <p className="flex gap-2 rounded-xl bg-secondary p-3 text-sm text-secondary-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                If something your slides need isn’t in your materials, TeachMate AI will flag it
                for you instead of making it up.
              </p>
            </FormSection>
          </Tabs.Panel>
        </Tabs.Root>

        <FormSection step={2} title="Class settings">
          <ChoiceGroup
            id="grade"
            label="Grade level"
            options={GRADE_LEVELS}
            value={settings.grade}
            error={errors.grade}
            onValueChange={(value) => updateSetting("grade", value)}
          />
          <div className="grid gap-6 md:grid-cols-2">
            <OptionSelect
              id="subject"
              label="Subject"
              placeholder="Select a subject"
              options={SUBJECTS}
              value={settings.subject}
              error={errors.subject}
              onValueChange={(value) => updateSetting("subject", value)}
            />
            <ChoiceGroup
              id="language"
              label="Language"
              options={LANGUAGES}
              value={settings.language}
              onValueChange={(value) => updateSetting("language", value)}
            />
          </div>
          <ChoiceGroup
            id="slide-count"
            label="Number of slides"
            options={SLIDE_COUNT_OPTIONS}
            value={settings.slideCount}
            onValueChange={(value) => updateSetting("slideCount", value)}
          />
        </FormSection>

        <FormSection step={3} title="Pick a look">
          <ThemePicker id="theme" value={settings.theme} onValueChange={(value) => updateSetting("theme", value)} />
        </FormSection>
        </>
        )}
      </div>

      <aside aria-label="Presentation summary" className="lg:sticky lg:top-10">
        <div className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold">Your presentation</h2>
          <SlidePreview colors={theme.colors} title={previewTitle} size="sm" />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <SummaryItem label="Source" value={mode === "topic" ? "Topic" : `${uploading ? run.files.length : files.length} file${(uploading ? run.files.length : files.length) === 1 ? "" : "s"}`} />
            <SummaryItem label="Grade" value={settings.grade ? labelFor(GRADE_LEVELS, settings.grade) : "—"} />
            <SummaryItem label="Subject" value={settings.subject ? labelFor(SUBJECTS, settings.subject) : "—"} />
            <SummaryItem label="Language" value={labelFor(LANGUAGES, settings.language)} />
            <SummaryItem label="Slides" value={settings.slideCount} />
            <SummaryItem label="Theme" value={theme.label} />
          </dl>

          <p
            id={GENERATION_NOTICE_ID}
            className="flex gap-2 rounded-xl border border-dashed border-input bg-muted/60 p-3 text-xs text-muted-foreground"
          >
            <FlaskConical className="mt-px size-4 shrink-0" aria-hidden="true" />
            {mode === "topic" ? (
              <span>
                <strong className="font-semibold text-foreground">Development preview.</strong> AI
                generation isn’t connected yet. You can check your details, but no presentation will
                be created.
              </span>
            ) : (
              <span>
                <strong className="font-semibold text-foreground">Development preview.</strong> Your
                files are uploaded privately, checked, and their text is read. Slide generation isn’t
                connected yet.
              </span>
            )}
          </p>

          {!uploading ? (
            <Button type="submit" className="h-11 w-full text-base" aria-describedby={GENERATION_NOTICE_ID}>
              {mode === "topic" ? <Sparkles data-icon="inline-start" aria-hidden="true" /> : <UploadCloud data-icon="inline-start" aria-hidden="true" />}
              {mode === "topic" ? "Generate from topic" : "Upload materials"}
            </Button>
          ) : (
            <Button type="button" disabled className="h-11 w-full text-base">
              {uploads.busy ? (
                <LoaderCircle data-icon="inline-start" aria-hidden="true" className="motion-safe:animate-spin" />
              ) : (
                <CircleCheck data-icon="inline-start" aria-hidden="true" />
              )}
              {run.phase === "creating" ? "Preparing upload…" : uploads.busy ? "Uploading…" : "Upload finished"}
            </Button>
          )}

          <div role="status" aria-live="polite">
            {status === "not-connected" && mode === "topic" ? (
              <p className="flex gap-2 rounded-xl bg-secondary p-3 text-sm text-secondary-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                Your details are complete. Generation isn’t connected yet, so no presentation was
                created.
              </p>
            ) : null}
          </div>
          {draftError ? (
            <p id="draft-error" tabIndex={-1} role="alert" className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/8 p-3 text-sm font-medium text-destructive outline-none">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {draftError.message}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            You’ll be able to review and edit every slide before exporting.
          </p>
        </div>
      </aside>
    </form>
  );
}

function FormSection({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-6 rounded-2xl border border-border bg-card p-5 sm:p-6">
      <h2 className="flex items-center gap-3 text-xl font-semibold">
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-full bg-accent font-sans text-sm font-bold text-accent-foreground"
        >
          {step}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

/** Moves focus to a field by id; radio groups focus their first radio. */
function focusField(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  if (element.getAttribute("role") === "radiogroup") {
    element.querySelector<HTMLElement>('[role="radio"]')?.focus();
    return;
  }
  element.focus();
}
