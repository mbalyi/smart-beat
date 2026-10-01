import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The left column: the note palette (durations, voices, effects) while the
 * song is being edited, and a short hint otherwise. A dark, compact grid of
 * icon buttons with tooltips, as in Guitar Pro 8.
 */
export function NotePalette({
  editing,
  children,
}: {
  editing: boolean;
  /** The edit and effects toolbars, shown in edit mode. */
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Note palette"
      className={cn(
        // Dark in both themes, like Guitar Pro 8's palette (the `dark` class scopes the dark tokens).
        "dark flex min-h-0 w-64 shrink-0 flex-col overflow-y-auto border-r bg-sidebar text-sidebar-foreground",
        // In narrow windows the palette sits above the score (it never covers it) while
        // editing, and is hidden otherwise.
        "max-lg:max-h-32 max-lg:w-full max-lg:border-r-0 max-lg:border-b",
        !editing && "max-lg:hidden",
      )}
    >
      {editing ? (
        children
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          Turn on edit mode in the toolbar to write notes, durations, techniques and more with the
          keyboard or this palette.
        </p>
      )}
    </aside>
  );
}
