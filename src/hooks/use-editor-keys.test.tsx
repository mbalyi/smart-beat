import { model } from "@coderline/alphatab";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";

import { EDITOR_SHORTCUTS, useEditorKeys } from "@/hooks/use-editor-keys";
import { ScoreEditor } from "@/lib/score/editor";
import { createSong } from "@/lib/score/tracks";

const { Duration } = model;

function Harness({
  editor,
  enabled = true,
  menuHandlesUndo = false,
  onBend,
}: {
  editor: ScoreEditor;
  enabled?: boolean;
  menuHandlesUndo?: boolean;
  onBend?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEditorKeys(ref, editor, { enabled, menuHandlesUndo, onBend });
  // A focusable stand-in for the score region.
  return <div ref={ref} tabIndex={0} role="region" aria-label="Score" />;
}

function setup(
  options: {
    enabled?: boolean;
    menuHandlesUndo?: boolean;
    platform?: string;
    onBend?: () => void;
  } = {},
) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(options.platform ?? "MacIntel");
  const editor = new ScoreEditor(createSong());
  render(<Harness editor={editor} {...options} />);
  screen.getByRole("region").focus();
  const user = userEvent.setup();
  const frets = () =>
    editor.score.tracks[0]!.staves[0]!.bars[editor.cursor.bar]!.voices[0]!.beats.map(
      (b) => b.notes.map((n) => `${n.string}:${n.fret}`).join(" ") || "r",
    );
  return { editor, user, frets };
}

describe("useEditorKeys", () => {
  it("switches note effects with their keys, and opens the bend editor", async () => {
    const onBend = vi.fn();
    const { user, editor } = setup({ onBend });
    await user.keyboard("5{ArrowRight}7{ArrowLeft}");
    const note = () => editor.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;

    await user.keyboard("h");
    expect(note().isHammerPullOrigin).toBe(true);
    await user.keyboard("plxow>");
    expect(note()).toMatchObject({
      isPalmMute: true,
      isLetRing: true,
      isDead: true,
      isGhost: true,
      vibrato: model.VibratoType.Slight,
      accentuated: model.AccentuationType.Normal,
    });
    await user.keyboard("n");
    expect(note().harmonicType).toBe(model.HarmonicType.Natural);
    await user.keyboard("s");
    expect(note().slideOutType).toBe(model.SlideOutType.Shift);
    await user.keyboard("P"); // Shift works too
    expect(note().isPalmMute).toBe(false);

    await user.keyboard("{Shift>}B{/Shift}");
    expect(onBend).toHaveBeenCalledOnce();
    // Plain B is still the pitch letter: B4 is fret 7 on this string.
    await user.keyboard("b");
    expect(note().fret).toBe(7);
  });

  it("types frets and moves between beats and strings", async () => {
    const { user, frets, editor } = setup();

    await user.keyboard("5{ArrowRight}{ArrowDown}7");
    expect(frets()).toEqual(["6:5", "5:7"]);

    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(editor.cursor.string).toBe(6);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}"); // nothing on this string of beat 2: no change
    await user.keyboard("{ArrowLeft}{Alt>}{ArrowUp}{/Alt}");
    expect(frets()).toEqual(["6:6", "5:7"]);
  });

  it("types pitches by letter, rests, ties, dots, durations, voices and beats", async () => {
    const { user, editor, frets } = setup();

    await user.keyboard("e");
    expect(frets()).toEqual(["6:0"]);
    await user.keyboard("+");
    expect(editor.beatInfo.duration).toBe(Duration.Eighth);
    await user.keyboard("-.");
    expect(editor.beatInfo).toMatchObject({ duration: Duration.Quarter, dots: 1 });
    await user.keyboard("{ArrowRight}t");
    expect(editor.beatInfo.notes[0]?.tied).toBe(true);
    await user.keyboard("r");
    expect(frets()).toEqual(["6:0", "r"]);
    await user.keyboard("i");
    expect(frets()).toEqual(["6:0", "r", "r"]);
    await user.keyboard("{Shift>}{Delete}{/Shift}");
    expect(frets()).toEqual(["6:0", "r"]);
    await user.keyboard("v");
    expect(editor.cursor.voice).toBe(1);
  });

  it("deletes notes, selects with Shift and clears the selection with Escape", async () => {
    const { user, editor, frets } = setup();
    await user.keyboard("3{ArrowRight}4{ArrowLeft}{Backspace}");
    expect(frets()).toEqual(["r", "6:4"]);

    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(editor.selection).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(editor.selection).toBeNull();

    await user.keyboard("{Meta>}{ArrowRight}{/Meta}");
    expect(editor.cursor.bar).toBe(1);
    await user.keyboard("{Meta>}{ArrowLeft}{/Meta}");
    expect(editor.cursor.bar).toBe(0);
  });

  it("copies, cuts, pastes and selects all with ⌘ on macOS", async () => {
    const { user, editor, frets } = setup();
    await user.keyboard("3{Meta>}c{/Meta}{ArrowRight}{Meta>}v{/Meta}");
    expect(frets()).toEqual(["6:3", "6:3"]);
    await user.keyboard("{Meta>}x{/Meta}");
    expect(frets()).toEqual(["6:3", "r"]);
    await user.keyboard("{Meta>}a{/Meta}");
    expect(editor.selection).not.toBeNull();
  });

  it("undoes with the keyboard in a browser, and leaves it to the menu in the app", async () => {
    const browser = setup();
    await browser.user.keyboard("3{Meta>}z{/Meta}");
    expect(browser.frets()).toEqual(["r"]);
    await browser.user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    expect(browser.frets()).toEqual(["6:3"]);
  });

  it("uses Ctrl (and Ctrl+Y) on Windows and Linux", async () => {
    const { user, frets } = setup({ platform: "Win32" });
    await user.keyboard("3{Control>}z{/Control}");
    expect(frets()).toEqual(["r"]);
    await user.keyboard("{Control>}y{/Control}");
    expect(frets()).toEqual(["6:3"]);
  });

  it("leaves Undo to the native menu in the desktop app", async () => {
    const { user, frets } = setup({ menuHandlesUndo: true });
    await user.keyboard("3{Meta>}z{/Meta}");
    expect(frets()).toEqual(["6:3"]);
  });

  it("does nothing outside edit mode", async () => {
    const { user, frets } = setup({ enabled: false });
    await user.keyboard("3");
    expect(frets()).toEqual(["r"]);
  });

  it("documents the keys", () => {
    expect(EDITOR_SHORTCUTS.length).toBeGreaterThan(10);
    expect(EDITOR_SHORTCUTS.every((s) => s.keys.length > 0 && s.label)).toBe(true);
  });

  it("Shift+1…7 choose the note value, whole to 64th", async () => {
    const { user, editor } = setup();
    for (const [key, duration] of [
      ["1", Duration.Whole],
      ["2", Duration.Half],
      ["3", Duration.Quarter],
      ["4", Duration.Eighth],
      ["5", Duration.Sixteenth],
      ["6", Duration.ThirtySecond],
      ["7", Duration.SixtyFourth],
    ] as const) {
      await user.keyboard(`{Shift>}${key}{/Shift}`);
      expect(editor.beatInfo.duration).toBe(duration);
    }
    // Without Shift the digits still type frets.
    await user.keyboard("5");
    expect(editor.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.fret).toBe(5);
  });

  it("Shift+R fills the bar with rests of the note value", async () => {
    const { user, editor } = setup();

    await user.keyboard("{Shift>}6{/Shift}{Shift>}r{/Shift}");

    const beats = editor.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    expect(beats).toHaveLength(32);
    expect(beats.every((b) => b.duration === Duration.ThirtySecond)).toBe(true);
    // A plain R still makes a rest of the beat under the cursor.
    await user.keyboard("r");
    expect(editor.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats).toHaveLength(32);
  });

  it("K starts replacing the drum under the cursor (drum tracks only)", async () => {
    const { user, editor } = setup();
    await user.keyboard("k"); // a guitar track: nothing happens
    expect(editor.message).not.toMatch(/Replace/);
    const spy = vi.spyOn(editor, "kind", "get").mockReturnValue("drums");
    const replace = vi.spyOn(editor, "startDrumReplace").mockImplementation(() => {});
    await user.keyboard("k");
    expect(replace).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("lists the new keys in the shortcuts", () => {
    const labels = EDITOR_SHORTCUTS.map((s) => s.label).join("\n");
    expect(labels).toMatch(/drum number/);
    expect(labels).toMatch(/Note value: whole/);
    expect(labels).toMatch(/Fill the bar with rests/);
    expect(labels).toMatch(/replace the drum under the cursor/);
  });
});
