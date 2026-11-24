import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, CircleAlert } from "lucide-react";

import { PresentationStatusView } from "@/components/presentation/presentation-status-view";
import { getPresentationDocumentsForCurrentUser } from "@/lib/server/documents";

export const metadata: Metadata = {
  title: "Presentation",
};

/** Retry/processing Server Actions run from this page too. */
export const maxDuration = 60;

export default function PresentationStatusPage({ params }: PageProps<"/dashboard/presentations/[presentationId]">) {
  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard" className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to dashboard
      </Link>
      <Suspense fallback={<StatusSkeleton />}>
        <StatusContent params={params} />
      </Suspense>
    </div>
  );
}

async function StatusContent({ params }: { params: PageProps<"/dashboard/presentations/[presentationId]">["params"] }) {
  const { presentationId } = await params;
  // requireUser() inside; RLS decides visibility. Unknown, foreign, deleted and invalid ids all
  // look the same (not found), so the page never reveals whether a presentation exists.
  const result = await getPresentationDocumentsForCurrentUser(presentationId);
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "INVALID_INPUT") notFound();
    return (
      <p role="alert" className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/8 p-4 text-sm font-medium text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {result.error.message}
      </p>
    );
  }
  return (
    <>
      <header>
        <p className="text-sm font-medium text-muted-foreground">Presentation</p>
        <h1 className="mt-1 text-3xl font-semibold break-words sm:text-4xl">{result.data.title}</h1>
      </header>
      <PresentationStatusView initial={result.data} />
    </>
  );
}

function StatusSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="h-12 w-2/3 animate-pulse rounded-xl bg-muted" />
      <div className="h-32 animate-pulse rounded-2xl bg-muted" />
      <div className="h-64 animate-pulse rounded-2xl bg-muted" />
    </div>
  );
}
