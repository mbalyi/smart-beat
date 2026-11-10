import { useEffect, useRef, type Ref } from "react";
import { LoaderCircleIcon } from "lucide-react";

import type { Layout, NoteRect, Rect } from "@/lib/score/player";
import { cn } from "@/lib/utils";

/**
 * What the editor marks on the sheet: the note (or empty spot) under the cursor, each with the
 * kind of staff it is drawn on, and the selected range (one rectangle per system row).
 */
export interface EditOverlay {
  notes: NoteRect[];
  selection: Rect[];
}

const box = ({ x, y, w, h }: Rect) => ({ left: x, top: y, width: w, height: h });

/**
 * Draws the editor's quiet marks over the notation (alphaTab draws the playback cursor
 * itself): a rounded outline around the fret number or the empty spot under the cursor, a thin
 * ring around its notehead on the standard staff, and a light rectangle for a range. Scrolls the
 * cursor into view when it moves.
 */
function EditOverlayLayer({ overlay }: { overlay: EditOverlay }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const { notes, selection } = overlay;
  // The outline goes on the tab; a score-only staff gets the outline on its notehead instead.
  const hasTab = notes.some((n) => n.staff === "tab");
  const outlines = notes.filter((n) => !hasTab || n.staff === "tab");
  const heads = hasTab ? notes.filter((n) => n.staff === "score") : [];
  const anchor = notes[0]?.rect ?? selection[0];

  useEffect(() => {
    anchorRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [anchor?.x, anchor?.y]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
      {selection.map((rect, i) => (
        <div
          key={i}
          ref={notes.length === 0 && i === 0 ? anchorRef : undefined}
          data-testid="edit-selection"
          className="absolute rounded-sm border border-brand/40 bg-brand/15"
          style={box(rect)}
        />
      ))}
      {outlines.map(({ rect }, i) => (
        <div
          key={i}
          ref={i === 0 ? anchorRef : undefined}
          data-testid="edit-cursor-note"
          className="absolute rounded-md border-2 border-brand bg-brand/10"
          style={box({ x: rect.x - 2, y: rect.y - 1, w: rect.w + 4, h: rect.h + 2 })}
        />
      ))}
      {heads.map(({ rect }, i) => (
        <div
          key={i}
          data-testid="edit-cursor-head"
          className="absolute rounded-md ring-1 ring-brand"
          style={box({ x: rect.x - 1, y: rect.y - 1, w: rect.w + 2, h: rect.h + 2 })}
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
  playing = false,
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
  /**
   * The song is playing: while editing, alphaTab's own playback cursor is hidden unless it is
   * (see src/index.css).
   */
  playing?: boolean;
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
        data-tour="score"
        data-testid="score-viewport"
        role="region"
        aria-label={label}
        aria-roledescription={editing ? "score editor" : undefined}
        aria-describedby={describedBy}
        aria-busy={rendering}
        tabIndex={0}
        data-layout={layout}
        data-editing={editing || undefined}
        data-playing={playing || undefined}
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
