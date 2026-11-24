import { Suspense } from "react";
import { CircleCheck, Layers, LoaderCircle, type LucideIcon } from "lucide-react";

import { RecentPresentations } from "@/components/dashboard/recent-presentations";
import { TeacherName } from "@/components/dashboard/teacher-card";
import { WelcomeBanner } from "@/components/dashboard/welcome-banner";
import { requireUser } from "@/lib/auth/dal";
import { MOCK_PRESENTATIONS } from "@/lib/mock-data";

export default function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  return (
    <div className="flex flex-col gap-8">
      <WelcomeBanner
        name={
          <Suspense fallback={null}>
            <TeacherName prefix=", " />
          </Suspense>
        }
      />
      <Suspense fallback={<PresentationsSkeleton />}>
        <DashboardContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

/**
 * `?view=empty` previews the empty state while we only have mock data.
 * Remove once presentations come from Supabase.
 */
async function DashboardContent({
  searchParams,
}: {
  searchParams: PageProps<"/dashboard">["searchParams"];
}) {
  // Per-page check: layouts don't re-run on client navigation, so each page verifies the user.
  await requireUser();
  const { view } = await searchParams;
  const presentations = view === "empty" ? [] : MOCK_PRESENTATIONS;

  const ready = presentations.filter((p) => p.status === "ready").length;
  const inProgress = presentations.filter((p) => p.status === "generating" || p.status === "draft").length;

  return (
    <>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat icon={Layers} label="Total presentations" value={presentations.length} tone="bg-accent text-accent-foreground" />
        <Stat icon={CircleCheck} label="Ready to export" value={ready} tone="bg-success text-success-foreground" />
        <Stat icon={LoaderCircle} label="In progress" value={inProgress} tone="bg-secondary text-secondary-foreground" />
      </dl>
      <RecentPresentations presentations={presentations} />
    </>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    // Valid <dl> group: the <div> holds only <dt> + <dd>. The decorative icon lives inside
    // the <dt> and is positioned against the card; flex-col-reverse shows the value first.
    <div className="relative flex flex-col-reverse justify-center rounded-2xl border border-border bg-card py-4 pr-4 pl-19">
      <dt className="text-sm text-muted-foreground">
        <span
          aria-hidden="true"
          className={`absolute top-1/2 left-4 flex size-11 -translate-y-1/2 items-center justify-center rounded-xl ${tone}`}
        >
          <Icon className="size-5" />
        </span>
        {label}
      </dt>
      <dd className="font-heading text-2xl font-semibold">{value}</dd>
    </div>
  );
}

function PresentationsSkeleton() {
  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="h-72 animate-pulse rounded-2xl bg-muted" />
      ))}
    </div>
  );
}
