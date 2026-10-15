/**
 * "Normalize drum notation" (#135): moves every drum note of a track onto a
 * standard, readable line of the drum tab, so each instrument family always
 * sits in the same place. Only the line a note is written on changes (see
 * `drum-lines.ts`); the drum that plays does not, so playback is unchanged.
 */
import { drumNumber, type Track } from "@/lib/score/model";
import { DRUM_TAB_LINES, setDrumLine } from "@/lib/score/drum-lines";
import { realStaves } from "@/lib/score/drum-tab";

/** A lane of the drum tab, numbered 1-6 from the top. */
export type DrumLane = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The layout, one row per family (the single place to adjust it). Snares and
 * mid toms deliberately share lane 4.
 */
export const DRUM_LANES: readonly { lane: DrumLane; name: string; drums: readonly number[] }[] = [
  { lane: 1, name: "Crash, splash, china", drums: [49, 52, 55, 57] },
  { lane: 2, name: "Hi-hat and ride", drums: [42, 44, 46, 51, 53, 59] },
  { lane: 3, name: "High toms", drums: [48, 50] },
  { lane: 4, name: "Snares and mid toms", drums: [37, 38, 39, 40, 45, 47] },
  { lane: 5, name: "Low toms", drums: [41, 43] },
  { lane: 6, name: "Kick", drums: [35, 36] },
];

/** Other percussion (cowbell, tambourine…) is written on the top lane. */
const OTHER_LANE: DrumLane = 1;

const LANE_OF = new Map(DRUM_LANES.flatMap(({ lane, drums }) => drums.map((d) => [d, lane])));

/** The lane (1 = top) a drum number is written on. */
export const laneOf = (drum: number): DrumLane => LANE_OF.get(drum) ?? OTHER_LANE;

/** Lane from the top to the tab line number alphaTab uses (6 = top). */
const lineOfLane = (lane: DrumLane) => DRUM_TAB_LINES + 1 - lane;

/** Whether the track can be normalized (a drum track). */
export const canNormalizeDrums = (track: Track): boolean =>
  track.isPercussion || (track.staves[0]?.isPercussion ?? false);

/** Moves the notes of a drum track onto the standard lanes. Returns how many notes moved. */
export function normalizeDrumNotation(track: Track): number {
  if (!canNormalizeDrums(track)) return 0;
  let count = 0;
  for (const staff of realStaves(track)) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) {
            if (!note.isPercussion) continue;
            setDrumLine(note, lineOfLane(laneOf(drumNumber(note))));
            count++;
          }
        }
      }
    }
  }
  return count;
}
