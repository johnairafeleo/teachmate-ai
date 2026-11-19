import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

type FieldProps = {
  /** Base id; label/description/error ids are derived from it. */
  id: string;
  label: string;
  /**
   * "label": a <label htmlFor={id}> for a single labelable control (input, textarea, select button).
   * "legend": a <fieldset>/<legend> for grouped controls (radio groups, file picker).
   */
  labelAs?: "label" | "legend";
  optional?: boolean;
  description?: string;
  error?: string;
  className?: string;
  children: ReactNode;
};

export function fieldIds(id: string) {
  return {
    label: `${id}-label`,
    description: `${id}-description`,
    error: `${id}-error`,
  };
}

/** aria-describedby value for a control inside <Field>. */
export function describedBy(id: string, { hasDescription, error }: { hasDescription?: boolean; error?: string }) {
  const ids = fieldIds(id);
  return [hasDescription ? ids.description : null, error ? ids.error : null].filter(Boolean).join(" ") || undefined;
}

const labelClassName = "flex items-center gap-2 text-sm font-semibold";

export function Field({
  id,
  label,
  labelAs = "label",
  optional,
  description,
  error,
  className,
  children,
}: FieldProps) {
  const ids = fieldIds(id);
  const labelContent = (
    <>
      {label}
      {optional ? <span className="text-xs font-normal text-muted-foreground">(optional)</span> : null}
    </>
  );
  const body = (
    <>
      {description ? (
        <p id={ids.description} className="-mt-1 text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={ids.error} className="flex items-center gap-1.5 text-sm font-medium text-destructive">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </>
  );

  if (labelAs === "legend") {
    return (
      <fieldset className={cn("m-0 min-w-0 border-0 p-0", className)}>
        <legend id={ids.label} className={cn(labelClassName, "mb-2 p-0")}>
          {labelContent}
        </legend>
        <div className="flex flex-col gap-2">{body}</div>
      </fieldset>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label id={ids.label} htmlFor={id} className={labelClassName}>
        {labelContent}
      </label>
      {body}
    </div>
  );
}
