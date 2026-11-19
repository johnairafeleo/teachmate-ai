import Link from "next/link";
import { CirclePlus, FileUp, Lightbulb } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

export function WelcomeBanner({ firstName }: { firstName: string }) {
  return (
    <section className="relative overflow-hidden rounded-3xl bg-linear-to-br from-brand-purple to-brand-blue p-6 text-white sm:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-white/10"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-24 -bottom-20 size-40 rounded-full bg-white/10"
      />
      <div className="relative flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="max-w-xl">
          <p className="text-sm font-medium text-white/80">Magandang araw!</p>
          <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">Welcome back, Teacher {firstName}</h1>
          <p className="mt-2 text-white/85">
            What are we teaching today? Start from a topic or turn your materials into slides.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            href="/dashboard/create"
            className={buttonVariants({
              variant: "secondary",
              className: "h-11 bg-white px-5 text-base text-primary hover:bg-white/90",
            })}
          >
            <CirclePlus data-icon="inline-start" />
            Create Presentation
          </Link>
        </div>
      </div>
      <div className="relative mt-6 flex flex-wrap gap-2 text-sm">
        <Link
          href="/dashboard/create?mode=topic"
          className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 font-medium transition-colors hover:bg-white/25 focus-visible:ring-3 focus-visible:ring-white/60 focus-visible:outline-none"
        >
          <Lightbulb className="size-4" aria-hidden="true" />
          From a topic
        </Link>
        <Link
          href="/dashboard/create?mode=materials"
          className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 font-medium transition-colors hover:bg-white/25 focus-visible:ring-3 focus-visible:ring-white/60 focus-visible:outline-none"
        >
          <FileUp className="size-4" aria-hidden="true" />
          From learning materials
        </Link>
      </div>
    </section>
  );
}
