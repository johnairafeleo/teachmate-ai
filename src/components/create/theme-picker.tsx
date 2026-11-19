"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Check } from "lucide-react";

import { Field, fieldIds } from "@/components/create/form-field";
import { SlidePreview } from "@/components/presentation/slide-preview";
import { THEMES } from "@/lib/presentation-options";

type ThemePickerProps = {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
};

export function ThemePicker({ id, value, onValueChange }: ThemePickerProps) {
  return (
    <Field id={id} label="Presentation theme" labelAs="legend">
      <RadioGroup
        id={id}
        value={value}
        onValueChange={(next) => onValueChange(String(next))}
        aria-labelledby={fieldIds(id).label}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {THEMES.map((theme) => (
          <Radio.Root
            key={theme.value}
            value={theme.value}
            aria-label={`${theme.label}: ${theme.description}`}
            className="group relative flex flex-col gap-2 rounded-xl border-2 border-transparent bg-card p-2 text-left ring-1 ring-border transition-all outline-none hover:ring-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-checked:ring-primary/20"
          >
            <SlidePreview colors={theme.colors} size="sm" />
            <span className="flex flex-col px-1 pb-1">
              <span className="text-sm font-semibold">{theme.label}</span>
              <span className="text-xs text-muted-foreground">{theme.description}</span>
            </span>
            <Radio.Indicator className="absolute top-3.5 right-3.5 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
              <Check className="size-3.5" aria-hidden="true" />
            </Radio.Indicator>
          </Radio.Root>
        ))}
      </RadioGroup>
    </Field>
  );
}
