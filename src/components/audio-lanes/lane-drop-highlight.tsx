import type { LaneDropTarget } from "@/lib/audio-lanes/drop-target";

/** The part of a lane's box that is on screen: its scrolling ancestors cut the rest off. */
function visibleBox(target: LaneDropTarget) {
  let { left, top } = target.rect;
  let right = left + target.rect.width;
  let bottom = top + target.rect.height;
  const element = target.element as unknown as HTMLElement;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (overflowX === "visible" && overflowY === "visible") continue;
    const box = parent.getBoundingClientRect();
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Marks the audio lane a dragged file would land on. The whole look of the drop target lives
 * here (the outline and the label), so it can be restyled in one place.
 */
export function LaneDropHighlight({
  target,
  laneName,
}: {
  target: LaneDropTarget | null;
  laneName: string;
}) {
  if (!target) return null;
  const box = visibleBox(target);
  return (
    <div
      aria-hidden="true"
      data-testid="lane-drop-highlight"
      data-drop-target={target.laneId}
      className="pointer-events-none fixed z-[60] rounded-sm ring-2 ring-primary"
      style={box}
    >
      <span className="absolute top-1 left-1 max-w-full truncate rounded bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
        Drop to add to {laneName}
      </span>
    </div>
  );
}
