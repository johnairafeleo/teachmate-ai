import Link from "next/link";
import { SearchX } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

/** Same page for unknown, someone else's, deleted and malformed presentation ids. */
export default function PresentationNotFound() {
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center">
      <span aria-hidden="true" className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <SearchX className="size-7" />
      </span>
      <h1 className="text-2xl font-semibold">Presentation not found</h1>
      <p className="text-sm text-muted-foreground">
        It may have been deleted, or the link is incorrect.
      </p>
      <Link href="/dashboard" className={buttonVariants({ className: "h-10 px-4" })}>
        Go to dashboard
      </Link>
    </section>
  );
}
