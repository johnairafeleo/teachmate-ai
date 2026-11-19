import { FileText, Languages, Layers, Lightbulb } from "lucide-react";

import { StatusBadge } from "@/components/dashboard/status-badge";
import { SlidePreview } from "@/components/presentation/slide-preview";
import { formatDate } from "@/lib/format";
import { GRADE_LEVELS, LANGUAGES, SUBJECTS, THEMES, labelFor } from "@/lib/presentation-options";
import type { PresentationSummary } from "@/lib/types";

export function PresentationCard({ presentation }: { presentation: PresentationSummary }) {
  const theme = THEMES.find((option) => option.value === presentation.theme) ?? THEMES[0];
  const ModeIcon = presentation.mode === "topic" ? Lightbulb : FileText;
  const modeLabel = presentation.mode === "topic" ? "From topic" : "From materials";

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-shadow hover:shadow-md">
      <div className="bg-muted/60 p-3">
        <SlidePreview colors={theme.colors} title={presentation.title} size="sm" />
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-sans text-base leading-snug font-semibold tracking-normal">
            {presentation.title}
          </h3>
          <StatusBadge status={presentation.status} className="shrink-0" />
        </div>
        <p className="text-sm text-muted-foreground">
          {labelFor(GRADE_LEVELS, presentation.grade)} · {labelFor(SUBJECTS, presentation.subject)}
        </p>
        <dl className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          {/* Groups hold only <dt>/<dd>; decorative icons sit inside the <dd>. */}
          <div>
            <dt className="sr-only">Slides</dt>
            <dd className="flex items-center gap-1">
              <Layers className="size-3.5" aria-hidden="true" />
              {presentation.slideCount} slides
            </dd>
          </div>
          <div>
            <dt className="sr-only">Language</dt>
            <dd className="flex items-center gap-1">
              <Languages className="size-3.5" aria-hidden="true" />
              {labelFor(LANGUAGES, presentation.language)}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Source</dt>
            <dd className="flex items-center gap-1">
              <ModeIcon className="size-3.5" aria-hidden="true" />
              {modeLabel}
            </dd>
          </div>
          <div className="ml-auto">
            <dt className="sr-only">Last updated</dt>
            <dd>
              <time dateTime={presentation.updatedAt}>{formatDate(presentation.updatedAt)}</time>
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
