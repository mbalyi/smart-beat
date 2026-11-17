import { createPortal } from "react-dom";

import type { PartDragView } from "@/components/audio/use-part-drag";
import { cn } from "@/lib/utils";

/** The chip that follows the pointer while a part is carried (a drop that would not fit is amber). */
export function PartDragChip({ view }: { view: PartDragView }) {
  if (!view.placing || view.mode !== "pointer") return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="part-drag-chip"
      className={cn(
        "pointer-events-none fixed z-[100] max-w-72 -translate-y-full rounded-full border px-3 py-1 text-xs font-semibold shadow-lg",
        view.accepted
          ? "border-primary bg-primary text-primary-foreground"
          : "border-amber-500 bg-amber-400 text-black",
      )}
      style={{ left: view.x + 14, top: view.y - 10 }}
    >
      {view.chip}
    </div>,
    document.body,
  );
}
