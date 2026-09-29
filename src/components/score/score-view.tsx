import type { Ref } from "react";
import { LoaderCircleIcon } from "lucide-react";

import type { Layout } from "@/lib/score/player";
import { cn } from "@/lib/utils";

/**
 * Scrollable "paper" that alphaTab draws the notation into. The paper stays
 * light in dark mode, like printed music, since the notation is drawn in black.
 */
export function ScoreView({
  viewportRef,
  surfaceRef,
  label,
  layout,
  rendering,
}: {
  viewportRef: Ref<HTMLDivElement>;
  surfaceRef: Ref<HTMLDivElement>;
  /** Accessible name of the scroll region, e.g. "Score: Bass". */
  label: string;
  layout: Layout;
  rendering: boolean;
}) {
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        role="region"
        aria-label={label}
        aria-busy={rendering}
        tabIndex={0}
        data-layout={layout}
        className="absolute inset-0 overflow-auto bg-muted/40 p-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:p-4"
      >
        <div
          className={cn(
            "score-paper min-h-full rounded-md bg-white text-black shadow-sm",
            // Page layout wraps to the paper width; continuous layout is one
            // long row, so the paper grows with it.
            layout === "page" ? "mx-auto" : "w-max min-w-full",
          )}
        >
          <div ref={surfaceRef} />
        </div>
      </div>
      {rendering && (
        <p
          role="status"
          className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1 text-sm shadow-sm"
        >
          <LoaderCircleIcon
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Rendering score…
        </p>
      )}
    </div>
  );
}
