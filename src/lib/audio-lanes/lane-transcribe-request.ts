/** Where a "convert audio to sheet" request came from; it only changes the dialog's opening step. */
export type LaneToTabOrigin = "clip" | "selection" | "lane" | "studio" | "record";

/** A span of the audio timeline, in ms. */
export interface LaneRange {
  startMs: number;
  endMs: number;
}

/**
 * What the lane-to-sheet dialog is opened with (#235). `clipIds` is empty for a whole lane or a
 * time range. `range` is a snapshot in timeline ms (null = the whole lane).
 */
export interface LaneToTabRequest {
  laneId: string;
  clipIds: string[];
  range: LaneRange | null;
  origin: LaneToTabOrigin;
}

// --- Resolving a request against the lanes as they are now (#235) ------------------------

/** What a request means once it is checked against the lanes. */
export interface ResolvedSource {
  /** The lane the sheet is made from (null: it is gone). */
  laneId: string | null;
  /** The clips still on that lane; one clip is sent by id, the rest as a range. */
  clipIds: string[];
  /** The span on the audio timeline (null: the whole lane). */
  range: LaneRange | null;
  /** Something the user should know about how the request was read. */
  notice: string | null;
}

interface LaneLike {
  id: string;
  clips: readonly { id: string; startMs: number; lengthMs: number; playrate: number }[];
}

const placedEnd = (clip: { startMs: number; lengthMs: number; playrate: number }) =>
  clip.startMs + clip.lengthMs / (clip.playrate > 0 ? clip.playrate : 1);

/**
 * Reads a request against the lanes now. Several clips on one lane give the union of their spans
 * (the placed span, so playrate and stretch need no special case). Clips that are gone (the user
 * split or deleted them while the dialog was open) leave the range as it was, with a notice.
 */
export function resolveClipRequest(
  lanes: readonly LaneLike[],
  request: Pick<LaneToTabRequest, "laneId" | "clipIds" | "range">,
): ResolvedSource {
  const lane = lanes.find((l) => l.id === request.laneId);
  if (!lane) return { laneId: null, clipIds: [], range: request.range, notice: null };
  const clips = lane.clips.filter((c) => request.clipIds.includes(c.id));
  if (request.clipIds.length > 0 && clips.length === 0) {
    return {
      laneId: lane.id,
      clipIds: [],
      range: request.range,
      notice: request.range
        ? "The clip was changed, so the time span it had is used instead."
        : "The clip was changed, so the whole track is used instead.",
    };
  }
  if (clips.length > 0) {
    return {
      laneId: lane.id,
      clipIds: clips.map((c) => c.id),
      range: {
        startMs: Math.min(...clips.map((c) => c.startMs)),
        endMs: Math.max(...clips.map(placedEnd)),
      },
      notice: null,
    };
  }
  return { laneId: lane.id, clipIds: [], range: request.range, notice: null };
}

/**
 * The request for several selected clips that may sit on several lanes: the lane of the clip that
 * was clicked (`clicked`) keeps its clips, and a notice says that the others are left out.
 */
export function requestFromSelection(
  lanes: readonly LaneLike[],
  selected: readonly string[],
  clicked: string,
  origin: LaneToTabOrigin,
): { request: LaneToTabRequest; notice: string | null } | null {
  const owner = lanes.find((l) => l.clips.some((c) => c.id === clicked));
  if (!owner) return null;
  const ids = selected.includes(clicked) ? selected : [clicked];
  const own = owner.clips.filter((c) => ids.includes(c.id)).map((c) => c.id);
  const others = ids.some((id) => !own.includes(id));
  return {
    request: { laneId: owner.id, clipIds: own, range: null, origin },
    notice: others ? "Only the clips on this track are converted, one track at a time." : null,
  };
}
