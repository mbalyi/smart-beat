import { toast } from "sonner";

import { activeMidiTake } from "@/lib/audio-lanes/midi";
import { buildPart, type LanePart } from "@/lib/audio-lanes/lane-transcribe";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { isDrumLane } from "@/lib/midi-editor/controllers";
import type { AudioLanesSettings } from "@/lib/tauri";

/**
 * Writes a MIDI clip's notes into the tab (ADR 0006), on a new track from the bar the clip
 * starts at, as one Undo step of the score: the same placement as "Convert audio to sheet".
 */
export function writeMidiClipToTab(options: {
  audio: AudioLanesSettings;
  grid: SongGrid;
  laneId: string;
  clipId: string;
  barCount: number;
  place: (part: LanePart, target: { track: number | null; bar: number }) => unknown;
}): boolean {
  const { audio, grid, laneId, clipId, barCount, place } = options;
  const lane = audio.lanes.find((l) => l.id === laneId);
  const clip = lane?.clips.find((c) => c.id === clipId);
  if (!lane || !clip?.midi) return false;
  const notes = activeMidiTake(clip)
    .notes.filter((n) => !n.muted)
    .map((n) => ({
      start: (clip.startMs + n.startMs) / 1000,
      end: (clip.startMs + n.startMs + n.lenMs) / 1000,
      pitch: n.pitch,
      velocity: n.vel,
    }));
  if (notes.length === 0) {
    toast.info("The clip has no notes to write");
    return false;
  }
  const part = buildPart(
    audio,
    grid,
    { notes, span: { startMs: clip.startMs, endMs: clip.startMs + clip.lengthMs } },
    {
      instrument: isDrumLane(lane) ? "drums" : "piano",
      tuning: [],
      laneName: lane.name,
      barCount,
    },
  );
  return place(part, { track: null, bar: part.originBar }) !== null;
}
