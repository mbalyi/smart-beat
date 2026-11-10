import type { Rect } from "@/lib/score/player";

/** The visible part of a scrolled region: its scroll offsets and inner size. */
export interface ScrollView {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Browsers keep scroll offsets in whole (device) pixels while the marks sit on fractions: a
 * target this far past an edge still counts as seen, or the view would creep a pixel each time.
 */
const SLACK_PX = 1;

/** The new offset on one axis, or null when `start…end` is already seen. */
function axis(start: number, end: number, viewStart: number, viewSize: number): number | null {
  const viewEnd = viewStart + viewSize;
  if (end - start <= viewSize) {
    if (start < viewStart - SLACK_PX) return start;
    if (end > viewEnd + SLACK_PX) return end - viewSize;
    return null;
  }
  // Larger than the view: fine while it fills the view, else its nearest edge comes in.
  if (start <= viewStart && end >= viewEnd) return null;
  return start > viewStart ? start : end - viewSize;
}

/**
 * Where to scroll so that `target` (in the region's content coordinates) is in view, moving as
 * little as possible: null when it is already fully visible (the view stays where it is), else
 * the new scroll offsets, which bring the nearer edge of the target just inside the view (#228).
 */
export function scrollToShow(target: Rect, view: ScrollView): { left: number; top: number } | null {
  const left = axis(target.x, target.x + target.w, view.left, view.width);
  const top = axis(target.y, target.y + target.h, view.top, view.height);
  if (left === null && top === null) return null;
  return { left: Math.max(0, left ?? view.left), top: Math.max(0, top ?? view.top) };
}
