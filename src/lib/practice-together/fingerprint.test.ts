import { describe, expect, it } from "vitest";

import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import { texScore } from "@/test/playback";
import { practiceSong } from "@/test/shared-edit";

const TAB = String.raw`
\title "T"
\tempo 120
\track "Guitar"
  \staff {score tabs}
  \instrument 25
  :4 3.6 5.5 7.4 r |
`;

describe("scoreFingerprint", () => {
  it("does not change with what a player sets for themselves (the bug that blocked every start)", async () => {
    const score = texScore(TAB);
    const base = (await scoreFingerprint(score)).key;
    const track = score.tracks[0]!;
    const staff = track.staves[0]!;
    track.playbackInfo.isMute = true;
    track.playbackInfo.isSolo = true;
    track.playbackInfo.volume = 3;
    track.playbackInfo.balance = 2;
    staff.showTablature = false;
    staff.showStandardNotation = false;
    expect((await scoreFingerprint(score)).key).toBe(base);
    // ...and nothing was left changed by the check.
    expect(track.playbackInfo.isMute).toBe(true);
    expect(track.playbackInfo.volume).toBe(3);
    expect(staff.showTablature).toBe(false);
  });

  it("changes with the music", async () => {
    const a = await scoreFingerprint(texScore(TAB));
    const b = await scoreFingerprint(texScore(TAB.replace("7.4", "7.3")));
    expect(a.key).not.toBe(b.key);
  });

  it("ignores the string of a drum note, which Guitar Pro gives back as a staff line", async () => {
    const score = practiceSong();
    const base = (await scoreFingerprint(score)).key;
    const drums = score.tracks.find((track) => track.staves[0]!.isPercussion)!;
    const notes = drums.staves[0]!.bars.flatMap((bar) =>
      bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes)),
    );
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((note) => note.isPercussion && Number.isNaN(note.string))).toBe(true);
    notes.forEach((note, i) => (note.string = (i % 6) + 1));
    expect((await scoreFingerprint(score)).key).toBe(base);
    // ...and the check leaves the strings as they were.
    expect(notes[1]!.string).toBe(2);
    // A guitar string is the music, though.
    const guitar = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    guitar.string = guitar.string === 1 ? 2 : 1;
    expect((await scoreFingerprint(score)).key).not.toBe(base);
  });
});
