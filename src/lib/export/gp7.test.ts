import { model } from "@coderline/alphatab";
import { describe, expect, it } from "vitest";

import { writeGp7 } from "@/lib/export/gp7";
import { loadSong } from "@/lib/import";
import { ScoreEditor } from "@/lib/score/editor";
import { drumNumber, type Score } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { fixtureBytes } from "@/test/score";

const drumTrackOf = (score: Score) => score.tracks.findIndex((t) => t.staves[0]?.isPercussion);

/** Every note of the song, track by track: drums by drum number, the rest by string and fret. */
const notesOf = (score: Score) =>
  score.tracks.map((track) =>
    track.staves[0]!.bars.flatMap((bar) =>
      bar.voices.flatMap((voice) =>
        voice.beats.map((beat) =>
          beat.notes.map((n) => (n.isPercussion ? drumNumber(n) : `${n.string}:${n.fret}`)),
        ),
      ),
    ),
  );

describe("writeGp7", () => {
  it("writes notes made after another file was read with ids of their own (#229)", async () => {
    const score = parseScore(fixtureBytes("practice-song.gp")).score;
    const track = drumTrackOf(score);
    // Reading any file starts alphaTab's note ids again from 0, so notes made afterwards get
    // the ids of notes already in the song (here: the guitar's first notes). Guitar Pro files
    // point at notes by id.
    const firstGuitarNote = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    (model.Note as unknown as { globalNoteId: number }).globalNoteId = firstGuitarNote.id;
    const editor = new ScoreEditor(score, track);
    editor.setCursorTo({ bar: 0, beat: 2 });
    editor.enterDrum(57);
    editor.enterDrum(44);
    const written = notesOf(score);
    const ids = score.tracks.map((t) => t.staves[0]!.bars[0]!.voices[0]!.beats[0]!.id);

    const again = (await loadSong(writeGp7(score), "song.gp")).score;

    expect(notesOf(again)).toEqual(written);
    // The song itself keeps its ids: only the file gets new ones.
    expect(score.tracks.map((t) => t.staves[0]!.bars[0]!.voices[0]!.beats[0]!.id)).toEqual(ids);
  });
});
