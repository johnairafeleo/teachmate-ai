import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

export function CtaSection() {
  return (
    <section className="px-4 pb-16 sm:px-6 md:pb-24">
      <div className="mx-auto max-w-6xl overflow-hidden rounded-3xl bg-linear-to-br from-brand-purple to-brand-blue px-6 py-12 text-center text-white sm:px-12 sm:py-16">
        <h2 className="text-3xl font-semibold text-balance sm:text-4xl">
          Your next lesson deserves great slides.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-lg text-white/85">
          Create your first presentation in a few clicks.
        </p>
        <Link
          href="/signup"
          className={buttonVariants({
            variant: "secondary",
            className: "mt-8 h-11 bg-white px-6 text-base text-primary hover:bg-white/90",
          })}
        >
          Get Started
          <ArrowRight data-icon="inline-end" />
        </Link>
      </div>
    </section>
  );
}
