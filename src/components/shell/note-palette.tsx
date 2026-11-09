import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Longest slide; the palette is removed after it even if no `animationend` arrives. */
const SLIDE_MS = 200;

/**
 * The left column: the note palette (durations, voices, effects), shown only
 * while the song is being edited so the score gets the full width otherwise.
 * It slides in from the left and out again (no motion with reduced motion).
 * A dark, compact grid of icon-only cells (8 per row) with tooltips; a cell with several variants
 * opens a small box of them.
 */
export function NotePalette({
  editing,
  children,
}: {
  editing: boolean;
  /** The palette's toolbars. */
  children: ReactNode;
}) {
  // Stays mounted while it slides out.
  const [closing, setClosing] = useState(false);
  const [wasEditing, setWasEditing] = useState(editing);
  if (wasEditing !== editing) {
    setWasEditing(editing);
    setClosing(!editing);
  }

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  if (!editing && !closing) return null;

  return (
    <aside
      aria-label="Note palette"
      data-tour="note-palette"
      data-state={editing ? "open" : "closed"}
      onAnimationEnd={() => {
        if (!editing) setClosing(false);
      }}
      className={cn(
        // Light or dark with the app (the sidebar tokens follow the theme).
        "flex min-h-0 w-[19.5rem] shrink-0 flex-col overflow-y-auto border-r bg-sidebar text-sidebar-foreground",
        "duration-200 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left",
        // In narrow windows the palette sits above the score (it never covers it).
        "max-lg:max-h-32 max-lg:w-full max-lg:border-r-0 max-lg:border-b max-lg:data-[state=closed]:slide-out-to-top max-lg:data-[state=open]:slide-in-from-top",
      )}
    >
      {children}
    </aside>
  );
}
