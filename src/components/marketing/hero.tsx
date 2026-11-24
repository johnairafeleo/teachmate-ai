import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

import { SlidePreview } from "@/components/presentation/slide-preview";
import { buttonVariants } from "@/components/ui/button";
import { THEMES } from "@/lib/presentation-options";

const [rainbow, ocean, jungle] = THEMES;

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[32rem] bg-[radial-gradient(ellipse_at_top,var(--color-accent),transparent_65%)]"
      />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-2">
        <div className="flex flex-col items-start gap-6">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground">
            <Sparkles className="size-4" aria-hidden="true" />
            Made for Grade 1–6 teachers
          </span>
          <h1 className="text-4xl leading-[1.1] font-semibold text-balance sm:text-5xl lg:text-6xl">
            Classroom-ready slides in{" "}
            <span className="bg-linear-to-r from-brand-purple to-brand-blue bg-clip-text text-transparent">
              minutes
            </span>
            , not hours.
          </h1>
          <p className="max-w-xl text-lg text-pretty text-muted-foreground">
            TeachMate AI turns a lesson topic — or your own learning materials — into a colorful,
            age-appropriate PowerPoint in English, Filipino, or Taglish. Review every slide, then
            export.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/signup" className={buttonVariants({ className: "h-11 px-5 text-base" })}>
              Get Started
              <ArrowRight data-icon="inline-end" />
            </Link>
            <a
              href="#how-it-works"
              className={buttonVariants({ variant: "outline", className: "h-11 px-5 text-base" })}
            >
              See how it works
            </a>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-lg" aria-hidden="true">
          <div className="absolute top-6 -left-4 w-3/5 -rotate-6 rounded-xl bg-card p-2 shadow-lg ring-1 ring-border sm:-left-8">
            <SlidePreview colors={ocean.colors} size="sm" title="Water Cycle" />
          </div>
          <div className="absolute -right-2 bottom-0 w-3/5 rotate-6 rounded-xl bg-card p-2 shadow-lg ring-1 ring-border sm:-right-6">
            <SlidePreview colors={jungle.colors} size="sm" title="Parts of a Plant" />
          </div>
          <div className="relative mx-auto my-14 w-4/5 rounded-2xl bg-card p-3 shadow-2xl ring-1 ring-border">
            <SlidePreview colors={rainbow.colors} size="md" title="Ang Aking Pamilya" />
            <div className="mt-3 flex items-center justify-between px-1 text-xs text-muted-foreground">
              <span>Grade 1 · Araling Panlipunan</span>
              <span>Slide 1 of 8</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
