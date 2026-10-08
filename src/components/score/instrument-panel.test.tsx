import { screen, within } from "@testing-library/react";

import { InstrumentPanel } from "@/components/score/instrument-panel";
import { DRUM_MIDI_MAP } from "@/lib/score/drum-map";
import type { NoteInfo } from "@/lib/score/editor";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { INSTRUMENT_SIZE_STORAGE_KEY } from "@/lib/score/instrument-view";

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
    expect(panel).toHaveTextContent("Standard: E B G D A E · Capo 2");
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

describe("InstrumentPanel: fret hint", () => {
  it("shows the string, fret and note under the mouse or the focus", async () => {
    const { user } = setup({ editing: true, cursorString: 6 });
    const hint = screen.getByTestId("fret-hint");
    expect(hint).toHaveTextContent("Point at a fret");
    await user.hover(screen.getAllByRole("button", { name: /^Fret 5, A/ })[0]!);
    expect(hint).toHaveTextContent(/^String \d, fret 5, a/);
    await user.unhover(screen.getAllByRole("button", { name: /^Fret 5, A/ })[0]!);
    expect(hint).toHaveTextContent("Point at a fret");
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

    // A click keeps the focus in the score; the keys are reached with Tab.
    screen.getByRole("button", { name: "C sharp4" }).focus();
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
  it("switches between the pads and the virtual drumkit", async () => {
    const { user } = setup({ kind: "drums", tuning: [], editing: true });
    await user.click(screen.getByRole("radio", { name: "Virtual drumkit" }));
    expect(screen.getByTestId("virtual-drumkit")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Pads" }));
    expect(screen.queryByTestId("virtual-drumkit")).not.toBeInTheDocument();
  });

  it("shows which drums are hit", async () => {
    setup({ kind: "drums", tuning: [], active: [note(null, null, 38), note(null, null, 42)] });
    expect(screen.getByRole("region", { name: "Drum pads" })).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAccessibleName("Drum pads. Snare (hit), Hi-Hat (closed)");
    await expectNoA11yViolations();
  });

  it("enters drum sounds by clicking pads, including unusual ones the track uses", async () => {
    const { user, props } = setup({ kind: "drums", tuning: [], editing: true, drumSounds: [81] });

    await user.click(screen.getByRole("button", { name: "49 Crash high (hit)" }));
    await user.click(screen.getByRole("button", { name: "81 Triangle (hit)" }));
    await user.click(screen.getByRole("button", { name: "92 Hi-Hat (half)" }));

    expect(vi.mocked(props.onDrum).mock.calls).toEqual([[49], [81], [92]]);
    await expectNoA11yViolations();
  });

  it("offers every Guitar Pro drum articulation as a pad labelled with its number (#53)", () => {
    setup({ kind: "drums", tuning: [], editing: true, drumSounds: [130] });
    for (const [key, name] of Object.entries(DRUM_MIDI_MAP)) {
      const pad = screen.getByRole("button", { name: `${key} ${name}` });
      expect(within(pad).getByTestId("drum-pad-number")).toHaveTextContent(key);
    }
    // The main kit comes first, in Guitar Pro's order, then the percussion.
    const kit = within(screen.getByRole("group", { name: "Drum kit" })).getAllByRole("button");
    expect(kit.slice(0, 3).map((b) => b.getAttribute("aria-label"))).toEqual([
      "38 Snare (hit)",
      "37 Snare (side stick)",
      "91 Snare (rim shot)",
    ]);
    expect(screen.getByRole("group", { name: "Percussion" })).toBeInTheDocument();
    // A number outside the map gets its own pad.
    expect(screen.getByRole("button", { name: "130 Drum sound 130" })).toBeInTheDocument();
  });
});

describe("InstrumentPanel: scale tool", () => {
  it("marks the scale's notes and root on the fretboard", async () => {
    const onScaleChange = vi.fn();
    const { user } = setup({
      scale: { root: 9, type: "minor-pentatonic" },
      onScaleChange,
    });
    const panel = screen.getByRole("region", { name: "Fretboard" });
    expect(panel).toHaveTextContent("A minor pentatonic: A C D E G");
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Fretboard. No notes. Scale: A minor pentatonic: A C D E G",
    );
    // Fret 5 of the low E string is A: the root.
    const roots = panel.querySelectorAll(".bg-amber-500");
    expect(roots.length).toBeGreaterThan(0);
    expect([...roots].every((r) => r.textContent === "A")).toBe(true);
    await expectNoA11yViolations();

    await user.click(screen.getByRole("combobox", { name: "Root" }));
    await user.click(await screen.findByRole("option", { name: "E" }));
    expect(onScaleChange).toHaveBeenLastCalledWith({ root: 4, type: "minor-pentatonic" });
    await user.click(screen.getByRole("combobox", { name: "Scale" }));
    await user.click(await screen.findByRole("option", { name: "Off" }));
    expect(onScaleChange).toHaveBeenLastCalledWith(null);
  });

  it("names scale notes on the frets while editing", () => {
    setup({ editing: true, scale: { root: 0, type: "major" }, onScaleChange: vi.fn() });
    // On the low E string: fret 8 is C3, fret 3 is G2, fret 2 is F sharp 2.
    expect(screen.getByRole("button", { name: "Fret 8, C3, scale root" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fret 3, G2, in the scale" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fret 2, F sharp2" })).toBeInTheDocument();
  });

  it("starts a scale on the key's tonic", async () => {
    const onScaleChange = vi.fn();
    const { user } = setup({ defaultScaleRoot: 7, onScaleChange });
    expect(screen.getByRole("combobox", { name: "Root" })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Scale" }));
    await user.click(await screen.findByRole("option", { name: "Major" }));
    expect(onScaleChange).toHaveBeenCalledWith({ root: 7, type: "major" });
  });

  it("marks scale notes on the piano keyboard", () => {
    setup({
      kind: "pitched",
      tuning: [],
      editing: true,
      scale: { root: 2, type: "dorian" },
      onScaleChange: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "D4, scale root" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "F4, in the scale" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "F sharp4" })).toBeInTheDocument();
    expect(screen.getByRole("group")).toHaveAccessibleName(
      "Piano keyboard: click a key to enter it. Scale: D dorian: D E F G A B C",
    );
  });

  it("has no scale tool for drums", () => {
    setup({ kind: "drums", tuning: [], onScaleChange: vi.fn(), scale: { root: 0, type: "major" } });
    expect(screen.queryByRole("combobox", { name: "Scale" })).not.toBeInTheDocument();
  });
});

describe("InstrumentPanel: keeping the keyboard focus in the score", () => {
  it("does not take focus when a fret, key or drum pad is clicked while editing", async () => {
    for (const kind of ["stringed", "pitched", "drums"] as const) {
      const { user, unmount } = setup({
        kind,
        tuning: kind === "stringed" ? GUITAR : [],
        editing: true,
        cursorString: 1,
      });
      const button = screen.getAllByRole("button").find((b) => b.getAttribute("aria-label"))!;
      const before = document.activeElement;

      await user.click(button);

      expect(document.activeElement).toBe(before);
      expect(document.activeElement).not.toBe(button);
      unmount();
    }
  });

  it("keeps the buttons reachable with Tab", async () => {
    const { user } = setup({ kind: "drums", tuning: [], editing: true });
    // The size slider comes first, then the buttons.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("slider", { name: "Instrument size" }));
    await user.tab();
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });
});

describe("InstrumentPanel: size and fret numbers (#83)", () => {
  it("shows the reference frets in the middle of the board, the octaves set apart", () => {
    setup();
    const markers = screen.getAllByTestId("fret-marker");
    expect(markers.map((m) => m.textContent)).toEqual([
      "3",
      "5",
      "7",
      "9",
      "•12•",
      "15",
      "17",
      "19",
      "21",
      "•24•",
    ]);
    // Faded, so the notes stay in front.
    expect(markers[0]!.style.gridColumn).toBe("5");
    expect(markers[0]!.className).toContain("opacity-75");
    expect(markers[4]!.className).toContain("font-bold");
  });

  it("makes the instruments bigger and remembers the size", async () => {
    const { user, container } = setup();
    const section = container.querySelector("section")!;
    expect(section.style.getPropertyValue("--instrument-size")).toBe("1");
    const slider = screen.getByRole("slider", { name: "Instrument size" });
    slider.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuetext", "150%");
    expect(section.style.getPropertyValue("--instrument-size")).toBe("1.5");
    expect(localStorage.getItem(INSTRUMENT_SIZE_STORAGE_KEY)).toBe("1.5");
    await expectNoA11yViolations();
  });
});
