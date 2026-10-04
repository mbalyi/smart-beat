import { model } from "@coderline/alphatab";

import { ScoreEditor, stateOf } from "@/lib/score/editor";
import { texScore } from "@/test/playback";

/** An editor with the cursor on the first note (string 3). */
function editor() {
  const e = new ScoreEditor(
    texScore(String.raw`\track "G" \staff {score tabs} :4 5.3 7.3 5.3 7.3 | 12.1 12.1 12.1 12.1`),
  );
  const first = e.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
  e.setCursorTo({ bar: 0, beat: 0, note: first.notes[0]! });
  return e;
}

describe("palette state (#53)", () => {
  it("says whether an effect is on every target, some or none", () => {
    expect(stateOf([])).toBe("off");
    expect(stateOf([false, false])).toBe("off");
    expect(stateOf([true, true])).toBe("on");
    expect(stateOf([true, false])).toBe("mixed");
  });

  it("follows the selection, with a mixed state", () => {
    const e = editor();
    e.toggleNoteEffect("palmMute"); // first note only
    expect(e.effectState("note", "palmMute")).toBe("on");
    e.moveBeat(1, true); // select two beats
    expect(e.effectState("note", "palmMute")).toBe("mixed");
    e.toggleNoteEffect("palmMute");
    expect(e.effectState("note", "palmMute")).toBe("on");
    e.moveBeat(1, false);
    expect(e.effectState("note", "palmMute")).toBe("off");
  });

  it("reads exclusive groups at the cursor: exactly one value", () => {
    const e = editor();
    e.setBeatEffect("dynamics", model.DynamicValue.PP);
    expect(e.effectValue("beat", "dynamics")).toBe(model.DynamicValue.PP);
    expect(e.effectState("beat", "dynamics", model.DynamicValue.PP)).toBe("on");
    expect(e.effectState("beat", "dynamics", model.DynamicValue.FF)).toBe("off");
  });

  it("puts fermatas on beats and takes them off, with undo", () => {
    const e = editor();
    e.toggleFermata();
    expect(e.fermataState).toBe("on");
    expect(e.score.masterBars[0]!.getFermata(e.cursorBeat()!)).not.toBeNull();
    e.toggleFermata();
    expect(e.fermataState).toBe("off");
    e.undo();
    expect(e.fermataState).toBe("on");
  });

  it("opens and closes repeats at the cursor's bar, with undo", () => {
    const e = editor();
    e.toggleRepeat("start");
    e.toggleRepeat("end");
    expect(e.score.masterBars[0]!.isRepeatStart).toBe(true);
    expect(e.score.masterBars[0]!.repeatCount).toBe(2);
    expect(e.repeatState("end")).toBe(true);
    e.undo();
    expect(e.repeatState("end")).toBe(false);
    expect(e.repeatState("start")).toBe(true);
  });
});
