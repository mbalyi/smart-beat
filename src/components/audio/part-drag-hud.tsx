import { createPortal } from "react-dom";

import type { PartDragView } from "@/components/audio/use-part-drag";

/** A small bar at the bottom of the window while a part is carried: what is happening and which keys do what. */
export function PartDragHud({ view }: { view: PartDragView }) {
  if (!view.placing) return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="part-drag-hud"
      className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col items-center gap-0.5 rounded-xl border bg-popover px-4 py-2 text-center text-sm text-popover-foreground shadow-lg"
    >
      <span className="font-semibold">{view.chip}</span>
      <span className="text-xs text-muted-foreground">
        {view.mode === "keyboard"
          ? "Arrows move, Page Up and Down jump four bars, Enter drops, Escape cancels"
          : "Release on a bar to drop, Escape cancels"}
      </span>
    </div>,
    document.body,
  );
}
