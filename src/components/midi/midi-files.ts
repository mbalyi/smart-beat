import { toast } from "sonner";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { addClip } from "@/lib/audio-lanes/edits";
import { fileNotes, laneToMidiFile } from "@/lib/audio-lanes/midi-file";
import { newMidiClip } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { errorText } from "@/lib/errors";
import { parse } from "@/lib/import/midi";
import {
  pickMidiFile,
  pickSavePath,
  readScoreFile,
  writeScoreFile,
  type AudioLane,
} from "@/lib/tauri";

/** Puts a MIDI file's notes on a MIDI lane as one clip at the position line (one Undo step). */
export async function importMidiOntoLane(lanes: AudioLanesController, lane: AudioLane) {
  try {
    const path = await pickMidiFile();
    if (!path) return;
    const parsed = parse(await readScoreFile(path));
    const { notes, lengthMs } = fileNotes(parsed);
    const name =
      path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.midi?$/i, "") ?? "MIDI file";
    const clip = newMidiClip(name, lanes.lineMs(), lengthMs, { notes: notes.slice(0, 20_000) });
    lanes.apply((a) => addClip(a, lane.id, clip));
    if (notes.length > 20_000) toast.warning("Only the first 20,000 notes of the file were added.");
    else toast.success(`Added ${notes.length} notes from “${name}”.`);
  } catch (error) {
    toast.error("Couldn't import the MIDI file", { description: errorText(error) });
  }
}

/** Saves a MIDI lane (its clips) as a standard MIDI file that follows the song's bars. */
export async function exportLaneMidi(lanes: AudioLanesController, lane: AudioLane, song: SongGrid) {
  try {
    const path = await pickSavePath(
      `${lane.name}.mid`,
      [{ name: "MIDI files", extensions: ["mid"] }],
      "Export MIDI",
    );
    if (!path) return;
    await writeScoreFile(path, laneToMidiFile(lanes.audio, song, lane.clips, lane.name));
    toast.success(`Saved “${path.split(/[\\/]/).pop()}”.`);
  } catch (error) {
    toast.error("Couldn't export the MIDI file", { description: errorText(error) });
  }
}
