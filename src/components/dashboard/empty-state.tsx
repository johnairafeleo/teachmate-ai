import Link from "next/link";
import { CirclePlus, Presentation } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

export function EmptyState() {
  return (
    <div className="flex flex-col items-center rounded-2xl border-2 border-dashed border-border bg-card px-6 py-14 text-center">
      <span
        aria-hidden="true"
        className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground"
      >
        <Presentation className="size-7" />
      </span>
      <h3 className="mt-5 text-xl font-semibold">No presentations yet</h3>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Start from a lesson topic or upload your learning materials. Your presentations will
        appear here.
      </p>
      <Link href="/dashboard/create" className={buttonVariants({ className: "mt-6 h-10 px-4" })}>
        <CirclePlus data-icon="inline-start" />
        Create your first presentation
      </Link>
    </div>
  );
}
