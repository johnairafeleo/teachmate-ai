import { CircleAlert, CircleCheck, LoaderCircle, PencilLine, type LucideIcon } from "lucide-react";

import type { PresentationStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<
  PresentationStatus,
  { label: string; icon: LucideIcon; className: string; iconClassName?: string }
> = {
  ready: {
    label: "Ready",
    icon: CircleCheck,
    className: "bg-success text-success-foreground",
  },
  generating: {
    label: "Generating",
    icon: LoaderCircle,
    className: "bg-secondary text-secondary-foreground",
    iconClassName: "motion-safe:animate-spin",
  },
  draft: {
    label: "Draft",
    icon: PencilLine,
    className: "bg-muted text-muted-foreground",
  },
  failed: {
    label: "Failed",
    icon: CircleAlert,
    className: "bg-danger text-danger-foreground",
  },
};

export function StatusBadge({ status, className }: { status: PresentationStatus; className?: string }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        config.className,
        className,
      )}
    >
      <Icon className={cn("size-3.5", config.iconClassName)} aria-hidden="true" />
      <span>
        <span className="sr-only">Status: </span>
        {config.label}
      </span>
    </span>
  );
}
