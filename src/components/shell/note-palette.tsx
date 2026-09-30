import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The left column: the note palette (durations, voices, effects) while the
 * song is being edited, and a short hint otherwise.
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
        "flex min-h-0 w-64 shrink-0 flex-col overflow-y-auto border-r bg-sidebar text-sidebar-foreground",
        // In narrow windows the palette covers the score while editing, and is hidden otherwise.
        "max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:z-20 max-lg:shadow-xl",
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
