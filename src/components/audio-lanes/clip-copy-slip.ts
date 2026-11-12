import type { ClipDrag } from "@/components/audio-lanes/clip-view";
import { gridStepMs, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { findClip } from "@/lib/audio-lanes/edits";
import { copyClipTo, slipClip, type SourceDuration } from "@/lib/audio-lanes/slip";

/** A copy-drag (⌘/Ctrl) or a slip-drag (⌥/Alt) of a clip. */
export type CopyOrSlipDrag = Extract<ClipDrag, { kind: "copy" | "slip" }>;

type Lanes = Pick<AudioLanesController, "apply" | "infos">;

const durations =
  (lanes: Lanes): SourceDuration =>
  (sourceId) =>
    lanes.infos.get(sourceId)?.durationMs;

/**
 * Applies a copy or a slip drop as one undoable edit. Returns false for the other drags (moves
 * and trims), which the host applies itself.
 */
export function dropCopyOrSlip(lanes: Lanes, drag: ClipDrag): drag is CopyOrSlipDrag {
  if (drag.kind === "copy") {
    lanes.apply((a) => copyClipTo(a, drag.clipId, drag.startMs, drag.laneId ?? undefined));
    return true;
  }
  if (drag.kind === "slip") {
    lanes.apply((a) => slipClip(a, drag.clipId, drag.deltaMs, durations(lanes)));
    return true;
  }
  return false;
}

/** Slips a clip's audio by a beat (a bar with `bar`) later or earlier: ⌥→ and ⌥←. */
export function slipByStep(
  lanes: Lanes & Pick<AudioLanesController, "grid">,
  clipId: string,
  direction: -1 | 1,
  bar: boolean,
): void {
  lanes.apply((a) => {
    const found = findClip(a, clipId);
    if (!found) return a;
    const step = gridStepMs(lanes.grid, found.clip.startMs, bar);
    return slipClip(a, clipId, direction * step, durations(lanes));
  });
}
