import { createPortal } from "react-dom";

import { selectionLabel, type Box } from "@/lib/audio-lanes/selection";

/**
 * The selection rectangle while clips are framed, in screen pixels. It is drawn over the page (a
 * portal), so a transformed dialog around the lanes does not move it.
 */
export function MarqueeBox({ box }: { box: Box | null }) {
  if (!box) return null;
  return createPortal(
    <span
      aria-hidden="true"
      data-testid="marquee"
      className="pointer-events-none fixed z-50 rounded-sm bg-primary/20 ring-1 ring-primary"
      style={{
        left: box.left,
        top: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
      }}
    />,
    document.body,
  );
}

/** Tells a screen reader how many clips are selected, as the selection changes. */
export function SelectionStatus({ count }: { count: number }) {
  return (
    <span role="status" className="sr-only" data-testid="clip-selection-status">
      {selectionLabel(count)}
    </span>
  );
}
