import { fireEvent, screen, within } from "@testing-library/react";
import { act, useState } from "react";

import {
  PedalboardDialog,
  type PedalboardSounds,
  type PedalboardTarget,
} from "@/components/audio/pedalboard-dialog";
import {
  defaultEffect,
  MAX_TRACK_EFFECTS,
  type EffectSlot,
  type EffectType,
} from "@/lib/audio/effects";
import { meters } from "@/lib/audio/meter-store";
import type { BlockProblem, LibraryItem, SongPreset } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

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
    note: "",
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
    note: "",
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

/**
 * A drag on the pedalboard (#128). Pointer events, not HTML5 drag events: on
 * macOS the webview hands the OS file drop to the window and never delivers
 * `drop` to elements, so the board is driven by the pointer. A press moves
 * past a small threshold, then the element under the pointer names the zone.
 */
function drag(from: HTMLElement, to: HTMLElement) {
  fireEvent.pointerDown(from, { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
  fireEvent.pointerMove(from, { clientX: 24, clientY: 5, pointerId: 1, buttons: 1 });
  fireEvent.pointerMove(to, { clientX: 40, clientY: 20, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(document.body, { pointerId: 1 });
}

const pedal = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole("listitem", { name: new RegExp(`^${name}`) });

describe("PedalboardDialog", () => {
  beforeEach(() => localStorage.clear());

  it("shows preset-load failures even while the plugin is processing", async () => {
    localStorage.setItem("smart-beat.plugins-enabled", "1");
    mockTauri({
      plugins_set_enabled: () => null,
      plugins_enabled: () => true,
      audio_plugin_info: () => [
        {
          index: 0,
          name: "Gain",
          latencySamples: 64,
          latencyMs: 1.3,
          alive: true,
          error: "The plugin cannot restore settings",
        },
      ],
    });
    setup({
      initial: [
        {
          type: "plugin",
          format: "clap",
          path: "/plugins/gain.clap",
          name: "Gain",
          state: "",
          enabled: true,
        },
      ],
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The plugin cannot restore settings");
    expect(alert).not.toHaveTextContent("Playing without it");
  });

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

  it("drags a scanned plugin before an existing pedal and back to the library", async () => {
    const plugin = {
      format: "vst3",
      path: "/plugins/Test Amp.vst3",
      name: "Test Amp",
      vendor: "Test",
      version: "1",
      hasGui: true,
    };
    mockTauri({
      plugins_enabled: () => false,
      plugins_set_enabled: () => null,
      plugins_scan: () => ({ plugins: [plugin], skipped: [] }),
      audio_plugin_info: () => [],
    });
    const { user, dialog, chain } = setup({ initial: [defaultEffect("gate")] });
    await user.click(within(dialog).getByRole("switch", { name: "Use third-party plugins" }));
    await user.click(within(dialog).getByRole("button", { name: /Scan for plugins/ }));
    const row = await within(dialog).findByTestId("library-plugin");
    drag(row, pedal(dialog, "Noise gate 1"));
    expect(types(chain())).toEqual(["plugin", "gate"]);
    expect(chain()[0]).toMatchObject({
      format: plugin.format,
      path: plugin.path,
      name: plugin.name,
      state: "",
    });
    drag(pedal(dialog, "Test Amp 1"), within(dialog).getByTestId("effect-library"));
    expect(types(chain())).toEqual(["gate"]);
  });

  it("lists the user's amps and cabinets and adds them by button or drag (#41)", async () => {
    const { user, dialog, chain } = setup({ initial: [defaultEffect("gate")] });
    const mine = within(dialog).getByRole("list", { name: "Your amps and cabinets" });
    const names = within(mine)
      .getAllByTestId("library-asset")
      .map((li) => li.textContent);
    expect(names.some((n) => n?.includes("My 5150") && n.includes("Amp"))).toBe(true);
    expect(names.some((n) => n?.includes("4×12 modern") && n.includes("Cab"))).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Add amp My 5150" }));
    expect(chain().map((s) => s.type)).toEqual(["gate", "amp"]);
    expect(chain()[1]).toMatchObject({ model: "abc", matchLoudness: false });
    // Dragging a cabinet in front of the gate.
    const cab = within(mine)
      .getAllByTestId("library-asset")
      .find((li) => li.textContent?.includes("4×12 modern"))!;
    drag(cab, pedal(dialog, "Noise gate 1"));
    expect(chain().map((s) => s.type)).toEqual(["cab", "gate", "amp"]);
    expect(chain()[0]).toMatchObject({ ir: "builtin:4x12-modern" });
    await expectNoA11yViolations();
  });

  it("does not add sounds to a full chain", async () => {
    const full = Array.from({ length: MAX_TRACK_EFFECTS }, () => defaultEffect("gate"));
    const { dialog, chain } = setup({ initial: full });
    const button = within(dialog).getByRole("button", { name: "Add amp My 5150" });
    expect(button).toBeDisabled();
    // A press that would drag a sound onto the board does nothing either.
    const asset = within(dialog).getAllByTestId("library-asset")[0]!;
    drag(asset, within(dialog).getByTestId("pedalboard"));
    expect(chain()).toHaveLength(MAX_TRACK_EFFECTS);
  });

  it("shows what is being dragged and cancels the drag on Escape (#128)", () => {
    const { dialog, chain } = setup({ initial: [defaultEffect("gate"), defaultEffect("cab")] });
    const grip = within(pedal(dialog, "Cabinet 2")).getByTestId("pedal-grip");
    fireEvent.pointerDown(grip, { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 24, clientY: 5, pointerId: 1, buttons: 1 });
    expect(within(dialog).getByTestId("drag-preview")).toHaveTextContent("Cabinet 2");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(within(dialog).queryByTestId("drag-preview")).not.toBeInTheDocument();
    // The press after the cancel is cleared too: no stale drag on the next move.
    fireEvent.pointerMove(within(dialog).getByTestId("pedalboard"), {
      clientX: 40,
      clientY: 20,
      pointerId: 1,
      buttons: 1,
    });
    fireEvent.pointerUp(document.body, { pointerId: 1 });
    expect(types(chain())).toEqual(["gate", "cab"]);
  });

  it("selects no text while dragging, but leaves the pedals' controls selectable (#128)", () => {
    const { dialog } = setup({ initial: [defaultEffect("gate")] });
    expect(dialog).not.toHaveClass("select-none");
    // A press on the pedal arms the drag: nothing may be selected on the way.
    const grip = within(pedal(dialog, "Noise gate 1")).getByTestId("pedal-grip");
    fireEvent.pointerDown(grip, { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
    expect(dialog).toHaveClass("select-none");
    fireEvent.pointerUp(document.body, { pointerId: 1 });
    expect(dialog).not.toHaveClass("select-none");
    // A press on a control is that control's, not a drag.
    fireEvent.pointerDown(within(dialog).getByRole("switch", { name: "Noise gate 1 on" }), {
      button: 0,
      clientX: 5,
      clientY: 5,
      pointerId: 1,
    });
    expect(dialog).not.toHaveClass("select-none");
  });

  it("adds, reorders and removes with the keyboard (#128)", async () => {
    // The library's Add buttons and the pedal's shortcuts work without a mouse.
    const { user, dialog, chain } = setup({
      initial: [defaultEffect("gate"), defaultEffect("cab")],
    });
    await user.click(within(dialog).getByRole("button", { name: "Add Reverb" }));
    expect(types(chain())).toEqual(["gate", "cab", "reverb"]);
    pedal(dialog, "Reverb 3").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(types(chain())).toEqual(["gate", "reverb", "cab"]);
    await user.keyboard("{Delete}");
    expect(types(chain())).toEqual(["gate", "cab"]);
  });

  it("switches loudness matching on an amp capture", async () => {
    const amp = { ...defaultEffect("amp"), model: "abc" } as EffectSlot;
    const { user, dialog, chain } = setup({ initial: [amp] });
    await user.click(
      within(dialog).getByRole("switch", { name: "Amp (capture) 1: Match loudness" }),
    );
    expect(chain()[0]).toMatchObject({ type: "amp", matchLoudness: true });
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
    await user.click(within(dialog).getByRole("button", { name: "Enable effects playback" }));
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

describe("PedalboardDialog: compressor, limiter and mastering (#39)", () => {
  it("offers drum and mastering presets on compressors, with a gain-reduction meter", async () => {
    const { user, dialog, chain } = setup({ initial: [defaultEffect("compressor")] });
    const compressor = pedal(dialog, "Compressor 1");
    await user.click(within(compressor).getByRole("combobox", { name: "Compressor 1: preset" }));
    await user.click(await screen.findByRole("option", { name: "Tight kick and snare" }));
    expect(chain()[0]).toMatchObject({ type: "compressor", ratio: 6, attackMs: 3, enabled: true });
    expect(
      within(compressor).getByRole("combobox", { name: "Compressor 1: preset" }),
    ).toHaveTextContent("Tight kick and snare");

    act(() => meters.set({ tracks: [], master: 0, reduction: { tracks: [[7.25]], master: [] } }));
    expect(
      within(compressor).getByRole("meter", { name: "Compressor 1: gain reduction" }),
    ).toHaveAttribute("aria-valuetext", "-7.3 dB");
    await expectNoA11yViolations();
  });

  it("builds a mastering chain of EQ, compressor and limiter, three blocks at most", async () => {
    const { user, dialog, chain } = setup({
      target: { track: null, name: "Master", presetTarget: "master" },
    });
    for (const name of ["Equalizer", "Compressor", "Limiter"]) {
      await user.click(within(dialog).getByRole("button", { name: `Add ${name}` }));
    }
    expect(types(chain())).toEqual(["eq", "compressor", "limiter"]);
    expect(within(dialog).getByRole("button", { name: "Add Reverb" })).toBeDisabled();
    const limiter = pedal(dialog, "Limiter 3");
    expect(within(limiter).getByRole("slider", { name: "Limiter 3, Ceiling" })).toHaveAttribute(
      "aria-valuetext",
      "-1.0 dB",
    );
    await user.click(within(limiter).getByRole("combobox", { name: "Limiter 3: preset" }));
    await user.click(await screen.findByRole("option", { name: "Master loud" }));
    expect(chain()[2]).toMatchObject({ inputDb: 8, ceilingDb: -0.8 });
    act(() => meters.set({ tracks: [], master: 0, reduction: { tracks: [], master: [0, 0, 3] } }));
    expect(
      within(limiter).getByRole("meter", { name: "Limiter 3: gain reduction" }),
    ).toHaveAttribute("aria-valuetext", "-3.0 dB");
  });
});
