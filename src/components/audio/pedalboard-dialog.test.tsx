import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";

import {
  PedalboardDialog,
  type PedalboardSounds,
  type PedalboardTarget,
} from "@/components/audio/pedalboard-dialog";
import { defaultEffect, type EffectSlot, type EffectType } from "@/lib/audio/effects";
import type { BlockProblem, LibraryItem, SongPreset } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const LIBRARY: LibraryItem[] = [
  {
    id: "builtin:4x12-modern",
    kind: "cab",
    name: "4×12 modern (generated)",
    tags: [],
    file: "",
    sampleRate: 0,
    source: "Smart Beat",
    builtin: true,
    includesCab: false,
  },
  {
    id: "abc",
    kind: "amp",
    name: "My 5150",
    tags: ["metal"],
    file: "abc.nam",
    sampleRate: 48_000,
    source: "5150.nam",
    builtin: false,
    includesCab: true,
  },
];

const TRACK: PedalboardTarget = { track: 0, name: "Rhythm guitar", presetTarget: "guitar" };

function setup({
  initial = [],
  target = TRACK,
  problems = [],
  engineOn = true,
  focusType,
  sounds,
  songPresets,
  onSongPresetsChange,
  onTargetChange,
}: {
  initial?: EffectSlot[];
  target?: PedalboardTarget;
  problems?: BlockProblem[];
  engineOn?: boolean;
  focusType?: EffectType;
  sounds?: PedalboardSounds;
  songPresets?: SongPreset[];
  onSongPresetsChange?: (presets: SongPreset[]) => void;
  onTargetChange?: (mastering: boolean) => void;
} = {}) {
  const onChange = vi.fn();
  const onImport = vi.fn();
  const onEnableEngine = vi.fn();
  let latest = initial;
  function Harness() {
    const [chain, setChain] = useState(initial);
    return (
      <PedalboardDialog
        open
        onOpenChange={vi.fn()}
        target={target}
        chain={chain}
        onChange={(next) => {
          latest = next;
          onChange(next);
          setChain(next);
        }}
        problems={problems}
        library={LIBRARY}
        onImport={onImport}
        onManageLibrary={vi.fn()}
        engineOn={engineOn}
        onEnableEngine={onEnableEngine}
        focusType={focusType}
        sounds={sounds}
        songPresets={songPresets}
        onSongPresetsChange={onSongPresetsChange}
        trackName={onTargetChange ? "Rhythm guitar" : undefined}
        onTargetChange={onTargetChange}
      />
    );
  }
  const utils = renderWithProviders(<Harness />);
  const dialog = screen.getByRole("dialog", { name: /Pedalboard: / });
  return { ...utils, dialog, onChange, onImport, onEnableEngine, chain: () => latest };
}

const types = (chain: EffectSlot[]) => chain.map((s) => s.type);

/** HTML5 drag and drop as jsdom dispatches it. */
function drag(from: HTMLElement, to: HTMLElement) {
  fireEvent.dragStart(from);
  fireEvent.dragOver(to);
  fireEvent.drop(to);
  fireEvent.dragEnd(from);
}

const pedal = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole("listitem", { name: new RegExp(`^${name}`) });

describe("PedalboardDialog", () => {
  beforeEach(() => localStorage.clear());

  it("starts empty and adds effects from the library, filtered by category", async () => {
    const { user, dialog, chain } = setup();
    expect(within(dialog).getByText(/No effects yet/)).toBeInTheDocument();
    const library = within(dialog).getByRole("list", { name: "Effects" });
    expect(within(library).getAllByRole("listitem").length).toBeGreaterThanOrEqual(12);
    await user.click(within(dialog).getByRole("combobox", { name: "Effect category" }));
    await user.click(screen.getByRole("option", { name: "Time" }));
    expect(
      within(library)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Delay", "Reverb"]);
    await user.click(within(dialog).getByRole("button", { name: "Add Reverb" }));
    await user.click(within(dialog).getByRole("button", { name: "Add Delay" }));
    expect(types(chain())).toEqual(["reverb", "delay"]);
    expect(within(dialog).getAllByTestId("effect-block")).toHaveLength(2);
    await expectNoA11yViolations();
  });

  it("drags effects onto the board, between pedals and back to the library", () => {
    const { dialog, chain } = setup({ initial: [defaultEffect("gate"), defaultEffect("cab")] });
    const board = within(dialog).getByTestId("pedalboard");
    const library = within(dialog).getByTestId("effect-library");
    const item = (name: string) =>
      within(library)
        .getAllByTestId("library-effect")
        .find((li) => li.textContent === name)!;
    // Onto a pedal: inserted before it.
    drag(item("Chorus"), pedal(dialog, "Cabinet 2"));
    expect(types(chain())).toEqual(["gate", "chorus", "cab"]);
    // Onto the empty part of the board: at the end.
    drag(item("Reverb"), board);
    expect(types(chain())).toEqual(["gate", "chorus", "cab", "reverb"]);
    // A pedal onto another: moved there.
    drag(pedal(dialog, "Reverb 4"), pedal(dialog, "Noise gate 1"));
    expect(types(chain())).toEqual(["reverb", "gate", "chorus", "cab"]);
    // A pedal back to the library: removed.
    drag(pedal(dialog, "Chorus 3"), library);
    expect(types(chain())).toEqual(["reverb", "gate", "cab"]);
  });

  it("removes with Delete and reorders with Alt+arrows and the buttons", async () => {
    const { user, dialog, chain } = setup({
      initial: [defaultEffect("gate"), defaultEffect("drive"), defaultEffect("cab")],
    });
    pedal(dialog, "Noise gate 1").focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(types(chain())).toEqual(["drive", "gate", "cab"]);
    await user.click(within(dialog).getByRole("button", { name: "Move Cabinet 3 left" }));
    expect(types(chain())).toEqual(["drive", "cab", "gate"]);
    pedal(dialog, "Drive 1").focus();
    await user.keyboard("{Delete}");
    expect(types(chain())).toEqual(["cab", "gate"]);
    await user.click(within(dialog).getByRole("button", { name: "Remove Noise gate 2" }));
    expect(types(chain())).toEqual(["cab"]);
  });

  it("turns knobs, flips switches and picks options on the pedals", async () => {
    const { user, dialog, chain } = setup({
      initial: [defaultEffect("delay"), defaultEffect("drive"), defaultEffect("ampSim")],
    });
    await user.click(within(dialog).getByRole("switch", { name: "Delay 1 on" }));
    expect(chain()[0]!.enabled).toBe(false);
    const time = within(dialog).getByRole("slider", { name: "Delay 1, Time" });
    expect(time).toHaveAttribute("aria-valuetext", "375 ms");
    time.focus();
    await user.keyboard("{ArrowUp}{ArrowUp}{PageDown}");
    // Page Down is a tenth of the range, snapped to the 1 ms step.
    expect(chain()[0]).toMatchObject({ timeMs: 177 });
    await user.keyboard("{End}");
    expect(chain()[0]).toMatchObject({ timeMs: 2000 });
    await user.click(within(dialog).getByRole("switch", { name: "Delay 1: Ping-pong" }));
    expect(chain()[0]).toMatchObject({ pingPong: true });
    await user.click(within(dialog).getAllByRole("combobox", { name: "Type" })[0]!);
    await user.click(screen.getByRole("option", { name: "Fuzz" }));
    expect(chain()[1]).toMatchObject({ mode: "fuzz" });
    await user.click(within(dialog).getByRole("combobox", { name: "Channel" }));
    await user.click(screen.getByRole("option", { name: "Lead" }));
    expect(chain()[2]).toMatchObject({ voicing: "lead" });
    const gain = within(dialog).getByRole("slider", { name: "Amp 3, Gain" });
    fireEvent.doubleClick(gain);
    expect(chain()[2]).toMatchObject({ gain: 0 });
  });

  it("edits EQ bands with knobs", async () => {
    const { user, dialog, chain } = setup({ initial: [defaultEffect("eq")] });
    const band = within(dialog).getByRole("slider", { name: "Equalizer 1, 1 kHz" });
    band.focus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    const eq = chain()[0]!;
    expect(eq.type === "eq" && eq.bands[5]!.gainDb).toBe(1);
  });

  it("loads presets, and saves them to the library or into the song", async () => {
    const onSongPresetsChange = vi.fn();
    const { user, dialog, chain } = setup({
      songPresets: [{ name: "Song tone", target: "guitar", effects: [defaultEffect("tremolo")] }],
      onSongPresetsChange,
    });
    await user.click(within(dialog).getByRole("combobox", { name: "Genre" }));
    await user.click(screen.getByRole("option", { name: "Djent" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Guitar presets" }));
    expect(screen.getByText("In this song")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Song tone/ }));
    expect(types(chain())).toEqual(["tremolo"]);
    await user.click(within(dialog).getByRole("combobox", { name: "Guitar presets" }));
    await user.click(
      screen.getAllByRole("option").find((o) => /djent/i.test(o.textContent ?? ""))!,
    );
    expect(chain().length).toBeGreaterThan(1);
    await user.type(within(dialog).getByLabelText("Save as preset"), "Mine");
    await user.click(within(dialog).getByRole("button", { name: "Save the preset to my presets" }));
    expect(localStorage.getItem("smart-beat:effect-presets")).toContain("Mine");
    await user.type(within(dialog).getByLabelText("Save as preset"), "Ours");
    await user.click(within(dialog).getByRole("button", { name: "Save in this song" }));
    expect(onSongPresetsChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "Song tone" }),
      expect.objectContaining({ name: "Ours", target: "guitar", effects: chain() }),
    ]);
  });

  it("limits the mastering chain to three effects", async () => {
    const { user, dialog, chain } = setup({
      target: { track: null, name: "Master", presetTarget: "master" },
    });
    for (const name of ["Add Compressor", "Add Equalizer", "Add Reverb"]) {
      await user.click(within(dialog).getByRole("button", { name }));
    }
    expect(types(chain())).toEqual(["compressor", "eq", "reverb"]);
    expect(within(dialog).getByRole("button", { name: "Add Delay" })).toBeDisabled();
    expect(within(dialog).getByText("The chain is full (3 effects).")).toBeInTheDocument();
  });

  it("picks amp captures and cabinets from the library, or imports one", async () => {
    const { user, dialog, chain, onImport } = setup({
      initial: [defaultEffect("amp"), defaultEffect("cab")],
    });
    await user.click(within(dialog).getByRole("combobox", { name: "Amp or pedal capture" }));
    await user.click(screen.getByRole("option", { name: /My 5150/ }));
    expect(chain()[0]).toMatchObject({ model: "abc" });
    await user.click(within(dialog).getAllByRole("button", { name: "Import…" })[1]!);
    expect(onImport).toHaveBeenCalledWith("cab");
  });

  it("shows why a block cannot play and offers to turn on the engine", async () => {
    const { user, dialog, onEnableEngine } = setup({
      initial: [defaultEffect("amp")],
      problems: [{ index: 0, message: "Amp model “x” is not in the library" }],
      engineOn: false,
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("not in the library");
    await user.click(within(dialog).getByRole("button", { name: "Turn it on" }));
    expect(onEnableEngine).toHaveBeenCalled();
  });

  it("opens at the block asked for", () => {
    const { dialog } = setup({
      initial: [defaultEffect("gate"), defaultEffect("eq")],
      focusType: "eq",
    });
    expect(pedal(dialog, "Equalizer 2")).toHaveAttribute("aria-current", "true");
  });

  it("switches between the track and the mastering chain", async () => {
    const onTargetChange = vi.fn();
    const { user, dialog } = setup({ onTargetChange });
    await user.click(within(dialog).getByRole("radio", { name: "Mastering" }));
    expect(onTargetChange).toHaveBeenCalledWith(true);
  });

  it("manages a track's sounds and where they switch", async () => {
    const sounds: PedalboardSounds = {
      names: ["Clean", "Lead"],
      current: 0,
      switches: [{ bar: 8, sound: 1 }],
      barCount: 16,
      onSelect: vi.fn(),
      onAdd: vi.fn(),
      onRename: vi.fn(),
      onRemove: vi.fn(),
      onSwitchesChange: vi.fn(),
    };
    const { user, dialog } = setup({ sounds });
    await user.click(within(dialog).getByRole("combobox", { name: "Sound" }));
    await user.click(screen.getByRole("option", { name: "Lead" }));
    expect(sounds.onSelect).toHaveBeenCalledWith(1);
    await user.click(within(dialog).getByRole("button", { name: "Add sound" }));
    expect(sounds.onAdd).toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Rename the sound" }));
    const name = within(dialog).getByRole("textbox", { name: "Sound" });
    await user.clear(name);
    await user.type(name, "Verse{Enter}");
    expect(sounds.onRename).toHaveBeenCalledWith(0, "Verse");
    await user.click(within(dialog).getByRole("button", { name: "Remove the sound" }));
    expect(sounds.onRemove).toHaveBeenCalledWith(0);

    const automation = within(dialog).getByRole("region", { name: "Sound automation" });
    const bar = within(automation).getByLabelText("From bar");
    expect(bar).toHaveValue(9);
    fireEvent.change(bar, { target: { value: "5" } });
    expect(sounds.onSwitchesChange).toHaveBeenLastCalledWith([{ bar: 4, sound: 1 }]);
    await user.click(within(automation).getByRole("button", { name: "Add a switch" }));
    expect(sounds.onSwitchesChange).toHaveBeenLastCalledWith([
      { bar: 8, sound: 1 },
      { bar: 9, sound: 1 },
    ]);
    await user.click(
      within(automation).getByRole("button", { name: "Remove the switch at bar 9" }),
    );
    expect(sounds.onSwitchesChange).toHaveBeenLastCalledWith([]);
    await expectNoA11yViolations();
  });
});
