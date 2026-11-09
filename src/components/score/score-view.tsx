import { useEffect, useRef, type Ref } from "react";
import { LoaderCircleIcon } from "lucide-react";

import type { Layout, NoteRect, Rect } from "@/lib/score/player";
import { scrollToShow } from "@/lib/score/scroll-to-show";
import { cn } from "@/lib/utils";

/**
 * What the editor marks on the sheet: the note (or empty spot) under the cursor, each with the
 * kind of staff it is drawn on, and the selected range (one rectangle per system row).
 */
export interface EditOverlay {
  notes: NoteRect[];
  selection: Rect[];
  /** The other players' cursors, in Practice together (#216). */
  remote?: RemoteMark[];
}

/** Where another player is: a name and colour, their beat and the range they selected. */
export interface RemoteMark {
  id: string;
  name: string;
  /** Hue in degrees: every player has their own. */
  hue: number;
  beat: Rect;
  selection: Rect[];
}

const box = ({ x, y, w, h }: Rect) => ({ left: x, top: y, width: w, height: h });

/**
 * Scrolls `viewport` just far enough to show `element`, and not at all while it is fully in
 * view (#228): edits re-draw the score, and the view must stay where it is.
 */
function keepInView(element: HTMLElement, viewport: HTMLElement) {
  const box = element.getBoundingClientRect();
  const frame = viewport.getBoundingClientRect();
  // The element's place in the scrolled content.
  const x = box.left - frame.left - viewport.clientLeft + viewport.scrollLeft;
  const y = box.top - frame.top - viewport.clientTop + viewport.scrollTop;
  const next = scrollToShow(
    { x, y, w: box.width, h: box.height },
    {
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    },
  );
  if (next) viewport.scrollTo({ ...next, behavior: "instant" });
  // Then the panels around the score bring it on screen, as in a small window, where alphaTab
  // draws nothing that is out of sight. The score itself no longer moves: the cursor is seen.
  element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/**
 * Draws the editor's quiet marks over the notation (alphaTab draws the playback cursor
 * itself): a rounded outline around the fret number or the empty spot under the cursor, a thin
 * ring around its notehead on the standard staff, and a light rectangle for a range. Each time
 * the marks are placed (the cursor moved, or the score was drawn again after an edit) the
 * cursor is kept in view, scrolling only when it would be outside it.
 */
function EditOverlayLayer({ overlay }: { overlay: EditOverlay }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const { notes, selection, remote = [] } = overlay;
  // The outline goes on the tab; a score-only staff gets the outline on its notehead instead.
  const hasTab = notes.some((n) => n.staff === "tab");
  const outlines = notes.filter((n) => !hasTab || n.staff === "tab");
  const heads = hasTab ? notes.filter((n) => n.staff === "score") : [];

  useEffect(() => {
    const anchor = anchorRef.current;
    const viewport = anchor?.closest<HTMLElement>("[data-score-viewport]");
    if (anchor && viewport) keepInView(anchor, viewport);
  }, [overlay]);

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
      {remote.map((mark) => {
        // Each player's own colour; the flag is dark enough for white text in both themes.
        const line = `hsl(${mark.hue} 70% 50%)`;
        const flag = `hsl(${mark.hue} 60% 30%)`;
        return (
          <div key={mark.id} data-testid="remote-cursor" data-player={mark.name}>
            {mark.selection.map((rect, i) => (
              <div
                key={i}
                className="absolute rounded-sm"
                style={{ ...box(rect), backgroundColor: `hsl(${mark.hue} 70% 50% / 0.14)` }}
              />
            ))}
            <div
              className="absolute rounded-md border-2"
              style={{
                ...box({
                  x: mark.beat.x - 2,
                  y: mark.beat.y - 1,
                  w: mark.beat.w + 4,
                  h: mark.beat.h + 2,
                }),
                borderColor: line,
              }}
            />
            <div
              className="absolute -translate-y-full rounded-t-md px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap text-white"
              style={{ left: mark.beat.x - 2, top: mark.beat.y - 1, backgroundColor: flag }}
            >
              {mark.name}
            </div>
          </div>
        );
      })}
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
        data-score-viewport
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
