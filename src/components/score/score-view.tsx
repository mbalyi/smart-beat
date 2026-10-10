import { useEffect, useRef, type Ref } from "react";
import { LoaderCircleIcon } from "lucide-react";

import type { Layout, Rect } from "@/lib/score/player";
import { cn } from "@/lib/utils";

/** Where the edit cursor, the note under it and the selection are drawn. */
export interface EditOverlay {
  cursor: Rect | null;
  notes: Rect[];
  selection: Rect[];
}

const box = ({ x, y, w, h }: Rect) => ({ left: x, top: y, width: w, height: h });

/**
 * Draws the edit cursor over the notation (alphaTab draws the playback
 * cursor itself). Scrolls it into view when it moves.
 */
function EditOverlayLayer({ overlay }: { overlay: EditOverlay }) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const { cursor } = overlay;

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursor?.x, cursor?.y]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
      {overlay.selection.map((rect, i) => (
        <div
          key={i}
          data-testid="edit-selection"
          className="absolute bg-sky-500/20"
          style={box(rect)}
        />
      ))}
      {cursor && (
        <div
          ref={cursorRef}
          data-testid="edit-cursor"
          className="absolute rounded-sm border-2 border-sky-600 bg-sky-500/10"
          style={box(cursor)}
        />
      )}
      {overlay.notes.map((rect, i) => (
        <div
          key={i}
          data-testid="edit-cursor-note"
          className="absolute rounded-sm bg-sky-600/35 ring-2 ring-sky-700"
          style={box({ x: rect.x - 2, y: rect.y - 2, w: rect.w + 4, h: rect.h + 4 })}
        />
      ))}
    </div>
  );
}

/**
 * Scrollable "paper" that alphaTab draws the notation into. In dark mode the paper is dark
 * and the notation light (#83); printing always uses the light colours.
 */
export function ScoreView({
  viewportRef,
  surfaceRef,
  label,
  layout,
  rendering,
  editing = false,
  overlay = null,
  problemRects = [],
  describedBy,
}: {
  viewportRef: Ref<HTMLDivElement>;
  surfaceRef: Ref<HTMLDivElement>;
  /** Accessible name of the scroll region, e.g. "Score: Bass". */
  label: string;
  layout: Layout;
  rendering: boolean;
  /** Edit mode: the region takes the editor's keys. */
  editing?: boolean;
  overlay?: EditOverlay | null;
  /** Bars with the wrong length, highlighted (also outside edit mode). */
  problemRects?: Rect[];
  /** Id of the element describing the editor's keys and state. */
  describedBy?: string;
}) {
  return (
    // `isolate`: alphaTab puts its cursor at z-index 1000; keep that inside the
    // score so it can't cover the mixer panel or other overlays.
    // Some of the score stays visible even in the smallest window (the area around it scrolls).
    <div className="relative isolate min-h-32 flex-1">
      <div
        ref={viewportRef}
        role="region"
        aria-label={label}
        aria-roledescription={editing ? "score editor" : undefined}
        aria-describedby={describedBy}
        aria-busy={rendering}
        tabIndex={0}
        data-layout={layout}
        data-editing={editing || undefined}
        className={cn(
          "absolute inset-0 overflow-auto bg-muted/40 p-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:p-4",
          editing && "focus-visible:ring-sky-600/60",
        )}
      >
        <div
          className={cn(
            "score-paper min-h-full rounded-md bg-white text-black shadow-sm dark:bg-[#18181b] dark:text-[#ececee]",
            // Page layout wraps to the paper width; continuous layout is one
            // long row, so the paper grows with it.
            layout === "page" ? "mx-auto" : "w-max min-w-full",
          )}
        >
          <div className="relative">
            <div ref={surfaceRef} />
            {problemRects.length > 0 && (
              <div className="pointer-events-none absolute inset-0 z-[5]" aria-hidden="true">
                {problemRects.map((rect, i) => (
                  <div
                    key={i}
                    data-testid="bar-problem"
                    className="absolute rounded-sm border-2 border-amber-500 bg-amber-400/15"
                    style={box(rect)}
                  />
                ))}
              </div>
            )}
            {overlay && <EditOverlayLayer overlay={overlay} />}
          </div>
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
