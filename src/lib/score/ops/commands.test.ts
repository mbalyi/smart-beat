import { model } from "@coderline/alphatab";

import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import type { ScoreEditor } from "@/lib/score/editor";
import { dump, practiceSong, Room } from "@/test/shared-edit";

const { Duration, GraceType } = model;

/** Every command of the editor that changes the music, as one player would run it. */
const COMMANDS: Record<string, (e: ScoreEditor) => void> = {
  "enter a fret": (e) => e.setFret(5),
  "enter a fret on another string": (e) => {
    e.moveString(-1);
    e.setFret(2);
  },
  "change a duration": (e) => e.setDuration(Duration.Eighth),
  dotted: (e) => e.toggleDots(1),
  triplet: (e) => e.setTuplet({ numerator: 3, denominator: 2 }),
  tie: (e) => {
    e.setFret(3);
    e.moveBeat(1);
    e.setFret(3);
    e.toggleTie();
  },
  "note effect": (e) => {
    e.setFret(4);
    e.toggleNoteEffect("palmMute");
  },
  "beat effect": (e) => {
    e.setFret(4);
    e.toggleBeatEffect("slap");
  },
  bend: (e) => {
    e.setFret(7);
    e.setBend([
      { offset: 0, value: 0 },
      { offset: 30, value: 4 },
    ]);
  },
  whammy: (e) => {
    e.setFret(7);
    e.setWhammy([
      { offset: 0, value: 0 },
      { offset: 30, value: -4 },
    ]);
  },
  "grace note": (e) => {
    e.setFret(7);
    e.setGrace(GraceType.BeforeBeat);
  },
  text: (e) => {
    e.setFret(7);
    e.setText("hello");
  },
  fermata: (e) => e.toggleFermata(),
  "repeat start": (e) => e.toggleRepeat("start"),
  "repeat end": (e) => e.toggleRepeat("end"),
  "make a rest": (e) => {
    e.setFret(2);
    e.clearNotes();
  },
  "delete at the cursor": (e) => {
    e.setFret(2);
    e.deleteAtCursor();
  },
  "insert a beat": (e) => e.insertBeat(),
  "delete a beat": (e) => e.deleteBeats(),
  "fill with rests": (e) => e.fillWithRests(),
  "insert a bar before": (e) => e.insertBar("before"),
  "insert a bar after": (e) => e.insertBar("after"),
  "insert a bar after the last": (e) => {
    e.setCursorTo({ bar: e.score.masterBars.length - 1, beat: 0 });
    e.insertBar("after");
  },
  "delete a bar": (e) => {
    e.deleteBar();
  },
  "copy and paste": (e) => {
    e.copyBar(0);
    e.moveBar(1);
    e.paste();
  },
  "paste bars": (e) => {
    e.copyBar(0);
    e.pasteBarsAfter(1);
  },
  "insert a rest before": (e) => e.insertRest("before"),
  "insert a rest after": (e) => e.insertRest("after"),
  "delete several bars": (e) => {
    e.deleteBars(1, 2);
  },
  "set a repeat end with a count": (e) => e.setRepeatEnd(3),
  "cut a bar": (e) => {
    e.cutBar(1);
  },
  "cut the selection and paste it": (e) => {
    e.selectAll();
    e.cut();
    e.setCursorTo({ bar: 1, beat: 0 });
    e.paste();
  },
  transpose: (e) => e.transpose(1),
  "select all and delete": (e) => {
    e.selectAll();
    e.deleteBeats();
  },
};

describe("shared editing: every editor command", () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    it(`${name}: the guest ends up with the same tab, and undo takes it back`, async () => {
      const room = new Room();
      const host = room.join("host", practiceSong());
      const guest = room.join("guest", practiceSong());
      room.settle();
      const original = JSON.stringify(dump(host));

      // The cursor starts on the first beat of bar 1; most commands work on bar 2.
      host.editor.setCursorTo({ bar: 1, beat: 0 });
      command(host.editor);
      room.settle();

      expect(room.resets).toEqual([]);
      expect(dump(guest)).toEqual(dump(host));
      expect((await scoreFingerprint(guest.editor.score)).key).toBe(
        (await scoreFingerprint(host.editor.score)).key,
      );

      // A guest's copy of the same command works too.
      const other = new Room();
      const h2 = other.join("host", practiceSong());
      const g2 = other.join("guest", practiceSong());
      g2.editor.setCursorTo({ bar: 1, beat: 0 });
      command(g2.editor);
      other.settle();
      expect(other.resets).toEqual([]);
      expect(dump(h2)).toEqual(dump(g2));

      // Undo everything this player did.
      while (host.editor.canUndo) host.editor.undo();
      room.settle();
      expect(dump(guest)).toEqual(dump(host));
      expect(JSON.stringify(dump(host))).toBe(original);
    });
  }
});
