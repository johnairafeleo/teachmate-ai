"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";

import { describedBy, Field, fieldIds } from "@/components/create/form-field";
import { cn } from "@/lib/utils";

type ChoiceGroupProps = {
  id: string;
  label: string;
  description?: string;
  error?: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
};

/** Single-choice pill buttons (accessible radio group with arrow-key navigation). */
export function ChoiceGroup({
  id,
  label,
  description,
  error,
  options,
  value,
  onValueChange,
  className,
}: ChoiceGroupProps) {
  return (
    <Field id={id} label={label} labelAs="legend" description={description} error={error} className={className}>
      <RadioGroup
        id={id}
        value={value}
        onValueChange={(next) => onValueChange(String(next))}
        aria-labelledby={fieldIds(id).label}
        aria-describedby={describedBy(id, { hasDescription: Boolean(description), error })}
        aria-invalid={error ? true : undefined}
        className="flex flex-wrap gap-2"
      >
        {options.map((option) => (
          <Radio.Root
            key={option.value}
            value={option.value}
            className={cn(
              "inline-flex h-10 min-w-12 items-center justify-center rounded-full border bg-card px-4 text-sm font-medium transition-colors outline-none select-none",
              "hover:border-primary/50 hover:bg-accent/60",
              "focus-visible:ring-3 focus-visible:ring-ring/50",
              "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
              error ? "border-destructive/60" : "border-input",
            )}
          >
            {option.label}
          </Radio.Root>
        ))}
      </RadioGroup>
    </Field>
  );
}
