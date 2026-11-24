import type { Ref } from "react";
import { CircleAlert, CircleCheck, Info } from "lucide-react";

import { cn } from "@/lib/utils";

const TONES = {
  error: { icon: CircleAlert, className: "border-destructive/30 bg-destructive/8 text-destructive" },
  success: { icon: CircleCheck, className: "border-success-foreground/25 bg-success text-success-foreground" },
  info: { icon: Info, className: "border-primary/20 bg-accent text-accent-foreground" },
} as const;

type FormAlertProps = {
  tone: keyof typeof TONES;
  id?: string;
  /** Errors interrupt (role="alert"); success and info are polite (role="status"). */
  live?: boolean;
  ref?: Ref<HTMLDivElement>;
  children: React.ReactNode;
};

export function FormAlert({ tone, id, live = true, ref, children }: FormAlertProps) {
  const { icon: Icon, className } = TONES[tone];
  return (
    <div
      id={id}
      ref={ref}
      tabIndex={-1}
      role={live ? (tone === "error" ? "alert" : "status") : undefined}
      className={cn("flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm outline-none", className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="font-medium">{children}</p>
    </div>
  );
}
