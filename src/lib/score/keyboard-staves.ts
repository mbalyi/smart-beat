/**
 * Keyboard (pitched) staves in a Guitar Pro 7 file. A staff of pitches without strings (a
 * piano, notes from a MIDI file) is a staff alphaTab 1.9 writes as a six-string guitar one,
 * every note with a string and a fret worked out for it, because Guitar Pro files have no
 * other notes. Read back it is a guitar tab staff (the instrument, the tab, the strings), not
 * the keyboard that was saved. Smart Beat's own files therefore list their keyboard staves in
 * an extra entry of the archive (Guitar Pro ignores it), and opening the file turns them back.
 */
import { listZip } from "@/lib/import/zip";
import type { Score, Staff } from "@/lib/score/model";
import { refinish } from "@/lib/score/model";
import { NO_VALUE } from "@/lib/score/no-value";

/** The archive entry that lists the keyboard staves. */
export const KEYBOARD_ENTRY = "Content/SmartBeat.json";

/** A staff by its track's and its own place in the song. */
export type StaffPosition = [track: number, staff: number];

const notesOf = (staff: Staff) =>
  staff.bars.flatMap((bar) => bar.voices.flatMap((voice) => voice.beats.flatMap((b) => b.notes)));

/** The staves alphaTab writes as guitar ones although they hold pitches (see above). */
export function keyboardStaves(score: Score): StaffPosition[] {
  const found: StaffPosition[] = [];
  score.tracks.forEach((track, t) =>
    track.staves.forEach((staff, s) => {
      if (staff.isPercussion || staff.tuning.length > 0) return;
      // alphaTab looks at the first note only.
      const first = notesOf(staff)[0];
      if (first && !first.isStringed) found.push([t, s]);
    }),
  );
  return found;
}

/** The text of the archive entry for these staves. */
export const keyboardEntryData = (staves: readonly StaffPosition[]): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ keyboards: staves }));

/** The staves an archive entry lists (nothing for text that is not one). */
export function parseKeyboardEntry(data: Uint8Array): StaffPosition[] {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as { keyboards?: unknown };
    if (!Array.isArray(parsed.keyboards)) return [];
    return parsed.keyboards.filter(
      (p): p is StaffPosition =>
        Array.isArray(p) && p.length === 2 && p.every((n) => Number.isInteger(n) && n >= 0),
    );
  } catch {
    return [];
  }
}

/** Turns the staves back into keyboard ones: pitches, no strings, no tuning. */
export function restoreKeyboardStaves(score: Score, staves: readonly StaffPosition[]): void {
  let changed = false;
  for (const [t, s] of staves) {
    const staff = score.tracks[t]?.staves[s];
    if (!staff || staff.isPercussion || staff.tuning.length === 0) continue;
    for (const note of notesOf(staff)) {
      if (!note.isStringed) continue;
      // What the note sounds, written for this staff's transposition (as alphaTab's pianos do).
      const written = note.realValue + staff.transpositionPitch;
      note.octave = Math.floor(written / 12);
      note.tone = ((written % 12) + 12) % 12;
      note.string = NO_VALUE;
      note.fret = NO_VALUE;
      note.showStringNumber = false;
    }
    staff.stringTuning.tunings = [];
    staff.stringTuning.name = "";
    changed = true;
  }
  if (changed) refinish(score);
}

/**
 * Turns back the keyboard staves a Smart Beat file lists (see above); false when the file is
 * another one's or lists none. The entry is stored, not deflated, so this needs no inflating.
 */
export function restoreKeyboardsOfFile(score: Score, bytes: Uint8Array): boolean {
  // A zip archive starts with "PK".
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  try {
    const entry = listZip(bytes).find((e) => e.name === KEYBOARD_ENTRY && e.method === 0);
    if (!entry) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start =
      entry.offset +
      30 +
      view.getUint16(entry.offset + 26, true) +
      view.getUint16(entry.offset + 28, true);
    const staves = parseKeyboardEntry(bytes.subarray(start, start + entry.size));
    restoreKeyboardStaves(score, staves);
    return staves.length > 0;
  } catch {
    // The song opens as it was read: a damaged note is no reason to refuse it.
    return false;
  }
}
