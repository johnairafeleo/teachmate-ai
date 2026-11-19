"use client";

import { describedBy, Field, fieldIds } from "@/components/create/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type OptionSelectProps = {
  id: string;
  label: string;
  placeholder: string;
  description?: string;
  error?: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
};

export function OptionSelect({
  id,
  label,
  placeholder,
  description,
  error,
  options,
  value,
  onValueChange,
}: OptionSelectProps) {
  return (
    <Field id={id} label={label} labelAs="label" description={description} error={error}>
      <Select
        items={options}
        value={value === "" ? null : value}
        onValueChange={(next) => onValueChange(next ?? "")}
      >
        <SelectTrigger
          id={id}
          aria-labelledby={fieldIds(id).label}
          aria-describedby={describedBy(id, { hasDescription: Boolean(description), error })}
          aria-invalid={error ? true : undefined}
          className="h-10! w-full bg-card"
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
