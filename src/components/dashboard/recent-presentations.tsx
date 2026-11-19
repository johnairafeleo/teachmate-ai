import { EmptyState } from "@/components/dashboard/empty-state";
import { PresentationCard } from "@/components/dashboard/presentation-card";
import type { PresentationSummary } from "@/lib/types";

export function RecentPresentations({ presentations }: { presentations: PresentationSummary[] }) {
  return (
    <section aria-labelledby="recent-heading" className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="recent-heading" className="text-2xl font-semibold">
            Recent presentations
          </h2>
          <p className="text-sm text-muted-foreground">Pick up where you left off.</p>
        </div>
      </div>

      {presentations.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {presentations.map((presentation) => (
            <li key={presentation.id} className="flex">
              <PresentationCard presentation={presentation} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
