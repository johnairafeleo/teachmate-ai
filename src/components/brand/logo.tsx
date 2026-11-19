import Link from "next/link";
import { Presentation } from "lucide-react";

import { cn } from "@/lib/utils";

type LogoProps = {
  href?: string;
  className?: string;
};

export function Logo({ href = "/", className }: LogoProps) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-xl bg-linear-to-br from-brand-purple to-brand-blue text-white shadow-sm"
      >
        <Presentation className="size-5" />
      </span>
      <span className="font-heading text-xl font-semibold tracking-tight">
        TeachMate <span className="text-primary">AI</span>
      </span>
    </Link>
  );
}
