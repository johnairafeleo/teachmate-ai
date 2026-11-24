import type { Metadata } from "next";
import { Suspense } from "react";

import { CreatePresentationForm } from "@/components/create/create-presentation-form";
import { EarlyDropGuard } from "@/components/create/early-drop-guard";
import { requireUser } from "@/lib/auth/dal";
import type { GenerationMode } from "@/lib/types";

export const metadata: Metadata = {
  title: "Create presentation",
};

/** Server Actions on this page (document processing) may run up to a minute. */
export const maxDuration = 60;

export default function CreatePresentationPage({ searchParams }: PageProps<"/dashboard/create">) {
  return (
    <div className="flex flex-col gap-8">
      {/* Outside <Suspense> so it is in the first HTML chunk, before the upload area can be used. */}
      <EarlyDropGuard />
      <header>
        <h1 className="text-3xl font-semibold sm:text-4xl">Create a presentation</h1>
        <p className="mt-2 text-muted-foreground">
          Choose how you’d like to start, set up your class details, and pick a theme.
        </p>
      </header>
      <Suspense fallback={<FormSkeleton />}>
        <FormWithMode searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

/** Reads `?mode=topic|materials` so dashboard shortcuts open the right mode. */
async function FormWithMode({
  searchParams,
}: {
  searchParams: PageProps<"/dashboard/create">["searchParams"];
}) {
  await requireUser();
  const { mode } = await searchParams;
  const initialMode: GenerationMode = mode === "materials" ? "materials" : "topic";
  // Keyed so client-side navigation between ?mode= links resets to the requested mode.
  return <CreatePresentationForm key={initialMode} initialMode={initialMode} />;
}

function FormSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]" aria-hidden="true">
      <div className="flex flex-col gap-6">
        <div className="h-24 animate-pulse rounded-2xl bg-muted" />
        <div className="h-72 animate-pulse rounded-2xl bg-muted" />
      </div>
      <div className="h-96 animate-pulse rounded-2xl bg-muted" />
    </div>
  );
}
