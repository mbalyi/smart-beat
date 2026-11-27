import { describe, expect, it } from "vitest";
import { fileNotes, laneToMidiFile, tickToMs } from "@/lib/audio-lanes/midi-file";
import { EMPTY_AUDIO, newMidiClip } from "@/lib/audio-lanes/model";
import { parse } from "@/lib/import/midi";

// 120 bpm 4/4: a bar is 2 s.
const song = { barTimes: [0, 2000, 4000, 6000], beats: [4, 4, 4, 4] };

describe("MIDI files and lanes", () => {
  it("converts ticks to ms through tempo changes", () => {
    const at = tickToMs({ division: 480, tempos: [{ tick: 480, bpm: 60 }] });
    expect(at(480)).toBe(500);
    expect(at(960)).toBe(1500);
  });

  it("writes a lane as a file that reads back with the same notes and timing", () => {
    const clip = newMidiClip("Riff", 2000, 2000, {
      notes: [
        { id: "a", startMs: 0, lenMs: 500, pitch: 60, vel: 90, chan: 0 },
        { id: "b", startMs: 1000, lenMs: 250, pitch: 38, vel: 120, chan: 9 },
        { id: "c", startMs: 1500, lenMs: 100, pitch: 50, vel: 10, chan: 0, muted: true },
      ],
      cc: [{ atMs: 0, kind: "cc", cc: 64, value: 127, chan: 0 }],
    });
    const bytes = laneToMidiFile(EMPTY_AUDIO, song, [clip], "Keys");
    const parsed = parse(bytes);
    expect(parsed.division).toBe(960);
    expect(parsed.tempos[0]!.bpm).toBeCloseTo(120);
    const { notes } = fileNotes(parsed);
    expect(
      notes.map((n) => [Math.round(n.startMs), Math.round(n.lenMs), n.pitch, n.vel, n.chan]),
    ).toEqual([
      [2000, 500, 60, 90, 0],
      [3000, 250, 38, 120, 9],
    ]);
  });
});
