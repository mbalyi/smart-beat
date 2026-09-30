import { screen, within } from "@testing-library/react";

import { InstrumentPanel } from "@/components/score/instrument-panel";
import type { NoteInfo } from "@/lib/score/editor";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const GUITAR = [64, 59, 55, 50, 45, 40];

function setup(overrides: Partial<Parameters<typeof InstrumentPanel>[0]> = {}) {
  const props = {
    kind: "stringed" as const,
    tuning: GUITAR,
    capo: 0,
    active: [] as NoteInfo[],
    editing: false,
    cursorString: null,
    onFret: vi.fn(),
    onPitch: vi.fn(),
    onDrum: vi.fn(),
    ...overrides,
  };
  return { ...renderWithProviders(<InstrumentPanel {...props} />), props };
}

const note = (string: number | null, fret: number | null, pitch: number): NoteInfo => ({
  string,
  fret,
  pitch,
  tied: false,
});

describe("InstrumentPanel: fretboard", () => {
  it("shows the tuning, capo and the notes being played", async () => {
    setup({ capo: 2, active: [note(6, 3, 69), note(1, 0, 42)] });

    const panel = screen.getByRole("region", { name: "Fretboard" });
    expect(panel).toHaveTextContent("Guitar Standard Tuning: E B G D A E · Capo 2");
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Fretboard. string 1 fret 5 (A4), string 6 fret 2 (F sharp2)",
    );
    // Frets are counted from the capo on the fretboard: fret 3 with capo 2 is at the 5th fret.
    expect(within(panel).getByText("3", { selector: ".rounded-full" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("enters notes by clicking frets while editing", async () => {
    const { user, props } = setup({ editing: true, cursorString: 5, capo: 1 });

    await user.click(screen.getByRole("button", { name: "Fret 7, B4" }));
    const string2 = screen.getByRole("group", { name: "String 2 (B3)" });
    expect(within(string2).getByRole("button", { name: "Fret 7, F sharp4" })).toBeInTheDocument();
    expect(props.onFret).toHaveBeenCalledWith(6, 7);
    // Behind the capo there is nothing to play.
    expect(within(string2).getByRole("button", { name: "Fret 0, B3" })).toBeDisabled();
    await expectNoA11yViolations();
  });

  it("moves between frets and strings with the arrow keys", async () => {
    const { user } = setup({ editing: true, cursorString: 6 });
    const start = screen.getByRole("button", { name: "Fret 0, E4" });
    expect(start).toHaveAttribute("tabindex", "0");

    start.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowDown}");

    const string2 = screen.getByRole("group", { name: "String 2 (B3)" });
    expect(within(string2).getByRole("button", { name: "Fret 2, C sharp4" })).toHaveFocus();
    await user.keyboard("{Enter}");
  });

  it("marks the played notes as pressed while editing", () => {
    setup({ editing: true, active: [note(6, 5, 69)] });
    expect(screen.getByRole("button", { name: "Fret 5, A4" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("InstrumentPanel: keyboard", () => {
  it("shows the notes on a piano keyboard", async () => {
    setup({ kind: "pitched", tuning: [], active: [note(null, null, 60), note(null, null, 64)] });
    expect(screen.getByRole("img")).toHaveAccessibleName("Piano keyboard. C4, E4");
    await expectNoA11yViolations();
  });

  it("enters pitches by clicking keys, and moves with the arrow keys", async () => {
    const { user, props } = setup({ kind: "pitched", tuning: [], editing: true });

    await user.click(screen.getByRole("button", { name: "C sharp4" }));
    expect(props.onPitch).toHaveBeenCalledWith(61);

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("button", { name: "D sharp4" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "C6" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("button", { name: "C3" })).toHaveFocus();
    await expectNoA11yViolations();
  });
});

describe("InstrumentPanel: drums", () => {
  it("shows which drums are hit", async () => {
    setup({ kind: "drums", tuning: [], active: [note(null, null, 38), note(null, null, 42)] });
    expect(screen.getByRole("region", { name: "Drum pads" })).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAccessibleName("Drum pads. Snare, Hi-hat (closed)");
    await expectNoA11yViolations();
  });

  it("enters drum sounds by clicking pads, including unusual ones the track uses", async () => {
    const { user, props } = setup({ kind: "drums", tuning: [], editing: true, drumSounds: [81] });

    await user.click(screen.getByRole("button", { name: "Crash cymbal" }));
    await user.click(screen.getByRole("button", { name: "Drum sound 81" }));

    expect(vi.mocked(props.onDrum).mock.calls).toEqual([[49], [81]]);
    await expectNoA11yViolations();
  });
});
