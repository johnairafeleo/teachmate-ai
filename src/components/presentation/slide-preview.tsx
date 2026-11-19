import type { ThemeOption } from "@/lib/presentation-options";
import { cn } from "@/lib/utils";

type SlidePreviewProps = {
  colors: ThemeOption["colors"];
  title?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
};

/**
 * Decorative 16:9 slide thumbnail rendered from theme colors.
 * Purely visual — hidden from assistive tech; callers supply accessible labels.
 */
export function SlidePreview({ colors, title, size = "md", className }: SlidePreviewProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-lg ring-1 ring-black/5",
        className,
      )}
      style={{ backgroundColor: colors.background }}
    >
      <div
        className="absolute -top-1/4 -right-[10%] aspect-square w-2/5 rounded-full opacity-80"
        style={{ backgroundColor: colors.shape }}
      />
      <div
        className="absolute -bottom-1/3 -left-[8%] aspect-square w-1/3 rounded-full opacity-60"
        style={{ backgroundColor: colors.accent }}
      />
      <div className="absolute inset-0 flex flex-col justify-center gap-[6%] px-[10%]">
        {title ? (
          <p
            className={cn(
              "font-heading leading-tight font-semibold",
              size === "lg" && "text-2xl sm:text-3xl",
              size === "md" && "text-base",
              size === "sm" && "text-[0.6rem]",
            )}
            style={{ color: colors.title }}
          >
            {title}
          </p>
        ) : (
          <div className="h-[12%] w-3/5 rounded-full" style={{ backgroundColor: colors.title }} />
        )}
        <div className="flex flex-col gap-[0.35em]">
          <div className="h-[0.4em] min-h-1 w-4/5 rounded-full opacity-40" style={{ backgroundColor: colors.title }} />
          <div className="h-[0.4em] min-h-1 w-3/5 rounded-full opacity-40" style={{ backgroundColor: colors.title }} />
        </div>
        <div className="h-[8%] min-h-1.5 w-1/4 rounded-full" style={{ backgroundColor: colors.accent }} />
      </div>
    </div>
  );
}
