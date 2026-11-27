import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControllerLane } from "@/components/midi/controller-lane";
import { EventList } from "@/components/midi/event-list";
import { InstrumentPicker } from "@/components/midi/instrument-picker";
import {
  GridPicker,
  HumanizeDialog,
  NotePropertiesDialog,
  QuantizeDialog,
  TransposeDialog,
} from "@/components/midi/note-dialogs";
import { useMidiLaneInput } from "@/components/midi/use-midi-lane-input";
import { DEFAULT_GRID } from "@/lib/audio-lanes/midi-edit";
import { controllerLabel } from "@/lib/midi-editor/controllers";
import { PIANO_ROWS, type View } from "@/lib/midi-editor/geometry";
import { DEFAULT_MIDI_PREFS, storeMidiPrefs } from "@/lib/midi/prefs";
import type { MidiCc, MidiNote } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const note = (
  id: string,
  startMs: number,
  pitch = 60,
  extra: Partial<MidiNote> = {},
): MidiNote => ({
  id,
  startMs,
  lenMs: 100,
  pitch,
  vel: 100,
  chan: 0,
  ...extra,
});
// 0.1 px per ms from 0: x = ms / 10.
const view: View = { originMs: 0, pxPerMs: 0.1, rowHeight: 10, rows: PIANO_ROWS };

beforeEach(() => localStorage.clear());

describe("the note dialogs", () => {
  it("quantize previews its choices, and bypass shows the notes as played", async () => {
    const onPreview = vi.fn();
    const onApply = vi.fn();
    const { user } = renderWithProviders(
      <QuantizeDialog
        open
        onOpenChange={() => {}}
        grid={DEFAULT_GRID}
        selectedCount={2}
        onPreview={onPreview}
        onApply={onApply}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Quantize" });
    expect(dialog).toHaveTextContent("2 selected notes");
    await user.click(within(dialog).getByRole("radio", { name: "Starts and ends" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Move earlier" }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Grid type" }), "swing");
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Swing amount (percent)" }), {
      target: { value: "50" },
    });
    expect(onPreview).toHaveBeenLastCalledWith({
      options: expect.objectContaining({ target: "startEnd", moveLeft: false }),
      grid: expect.objectContaining({ type: "swing", swing: 0.5 }),
    });
    await user.click(within(dialog).getByRole("checkbox", { name: "Bypass (hear it as played)" }));
    expect(onPreview).toHaveBeenLastCalledWith(null);
    await user.click(within(dialog).getByRole("button", { name: "Quantize" }));
    expect(onApply).toHaveBeenCalled();
  });

  it("humanize and transpose apply their amounts", async () => {
    const humanize = vi.fn();
    const transpose = vi.fn();
    const { user, rerender } = renderWithProviders(
      <HumanizeDialog open onOpenChange={() => {}} selectedCount={0} onApply={humanize} />,
    );
    await user.click(screen.getByRole("button", { name: "Humanize" }));
    expect(humanize).toHaveBeenCalledWith({ timingMs: 10, velocity: 8 });
    rerender(
      <TransposeDialog open onOpenChange={() => {}} selectedCount={0} onApply={transpose} />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Transpose" });
    await user.click(within(dialog).getByRole("radio", { name: "Octave down" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Snap the notes to a scale" }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Key" }), "2");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Scale" }), "minor");
    await user.click(within(dialog).getByRole("button", { name: "Transpose" }));
    expect(transpose).toHaveBeenCalledWith(-12, { root: 2, steps: [0, 2, 3, 5, 7, 8, 10] });
  });

  it("note properties reads note names and refuses a wrong one", async () => {
    const onApply = vi.fn();
    const { user } = renderWithProviders(
      <NotePropertiesDialog
        open
        onOpenChange={() => {}}
        notes={[note("a", 0)]}
        onApply={onApply}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Note properties" });
    const pitch = within(dialog).getByRole("textbox", { name: /Pitch/ });
    expect(pitch).toHaveValue("C4");
    await user.clear(pitch);
    await user.type(pitch, "zz");
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.clear(pitch);
    await user.type(pitch, "+12");
    const velocity = within(dialog).getByRole("textbox", { name: /Velocity/ });
    await user.clear(velocity);
    await user.type(velocity, "40");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    const changes = onApply.mock.calls[0]![0] as { pitch: (p: number) => number; vel: number };
    expect(changes.vel).toBe(40);
    expect(changes.pitch(60)).toBe(72);
    await expectNoA11yViolations(dialog);
  });

  it("the grid picker changes the value", async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <GridPicker grid={DEFAULT_GRID} onChange={onChange} compact />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Grid" }), String(1 / 8));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_GRID, value: 1 / 8 });
  });
});

describe("ControllerLane", () => {
  const box = { left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100, x: 0, y: 0 };
  const lane = (el: HTMLElement) => {
    el.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
    return el;
  };

  it("paints the velocity of the notes under the pointer", () => {
    const onNotes = vi.fn();
    renderWithProviders(
      <ControllerLane
        kind={{ type: "velocity" }}
        view={view}
        width={1000}
        height={100}
        clipStartMs={0}
        notes={[note("a", 100), note("b", 500)]}
        cc={[]}
        selected={new Set()}
        channel={0}
        snap={(ms) => ms}
        color="red"
        onNotes={onNotes}
        onCc={() => {}}
      />,
    );
    const el = lane(screen.getByRole("application", { name: "Velocity lane" }));
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 50 });
    fireEvent.pointerMove(el, { clientX: 50, clientY: 0 });
    fireEvent.pointerUp(el, {});
    expect(onNotes.mock.calls[0]![0].map((n: MidiNote) => n.vel)).toEqual([64, 127]);
  });

  it("draws controller points, replaces nearby ones and deletes with Alt", () => {
    const onCc = vi.fn();
    const existing: MidiCc[] = [{ atMs: 300, kind: "cc", cc: 1, value: 10, chan: 0 }];
    const { rerender } = renderWithProviders(
      <ControllerLane
        kind={{ type: "cc", cc: 1 }}
        view={view}
        width={1000}
        height={100}
        clipStartMs={0}
        notes={[]}
        cc={existing}
        selected={new Set()}
        channel={2}
        snap={(ms) => ms}
        color="red"
        onNotes={() => {}}
        onCc={onCc}
      />,
    );
    const el = lane(screen.getByRole("application", { name: "CC 1 Modulation lane" }));
    fireEvent.pointerDown(el, { button: 0, clientX: 20, clientY: 0 });
    fireEvent.pointerUp(el, {});
    expect(onCc.mock.calls[0]![0]).toEqual([
      { atMs: 200, kind: "cc", cc: 1, value: 127, chan: 2 },
      existing[0],
    ]);
    fireEvent.pointerDown(el, { button: 0, clientX: 30, clientY: 50, altKey: true });
    expect(onCc).toHaveBeenLastCalledWith([]);
    rerender(
      <ControllerLane
        kind={{ type: "bend" }}
        view={view}
        width={1000}
        height={100}
        clipStartMs={0}
        notes={[]}
        cc={[{ atMs: 0, kind: "bend", value: 0, chan: 0 }]}
        selected={new Set()}
        channel={0}
        snap={(ms) => ms}
        color="red"
        onNotes={() => {}}
        onCc={onCc}
      />,
    );
    expect(screen.getAllByTestId("controller-point")).toHaveLength(1);
    expect(controllerLabel({ type: "pressure" })).toBe("Channel pressure");
    expect(controllerLabel({ type: "cc", cc: 99 })).toBe("CC 99");
  });
});

describe("EventList", () => {
  const props = (over = {}) => ({
    notes: [note("a", 0), note("b", 500, 62)],
    cc: [{ atMs: 100, kind: "program" as const, value: 4, chan: 0 }],
    selected: new Set<string>(["b"]),
    cursorMs: 250,
    formatMs: (ms: number) => `t${ms}`,
    onSelect: vi.fn(),
    onNotes: vi.fn(),
    onCc: vi.fn(),
    onAdd: vi.fn(),
    ...over,
  });

  it("lists notes and controllers, filters, adds, edits and deletes", async () => {
    const p = props();
    const { user } = renderWithProviders(<EventList {...p} />);
    expect(screen.getByText("3 events")).toBeInTheDocument();
    expect(screen.getByText("Program change")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Show events" }), "notes");
    expect(screen.getByText("2 events")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(p.onAdd).toHaveBeenCalledWith(250);
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(p.onNotes).toHaveBeenLastCalledWith([p.notes[0]]);
    const pitch = screen.getByRole("textbox", { name: "Pitch of the note at t0" });
    await user.clear(pitch);
    await user.type(pitch, "D4{Enter}");
    expect(p.onNotes).toHaveBeenLastCalledWith([{ ...p.notes[0], pitch: 62 }, p.notes[1]]);
    const length = screen.getByRole("textbox", { name: "Length of the note at t0" });
    await user.clear(length);
    await user.type(length, "300");
    await user.keyboard("{Escape}");
    expect(p.onNotes).not.toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ lenMs: 300 })]),
    );
    await user.click(screen.getByRole("button", { name: "Delete the note at t500" }));
    expect(p.onNotes).toHaveBeenLastCalledWith([p.notes[0]]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Show events" }), "controllers");
    await user.click(screen.getByRole("button", { name: "Delete the controller event at t100" }));
    expect(p.onCc).toHaveBeenCalledWith([]);
  });

  it("says when there are no events", () => {
    renderWithProviders(<EventList {...props({ notes: [], cc: [] })} />);
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
  });
});

describe("InstrumentPicker", () => {
  it("chooses a General MIDI sound, an imported kit and a plugin instrument", async () => {
    mockTauri({
      kits_list: () => [{ id: "k1", name: "Studio kit" }],
      plugins_scan: () => ({
        plugins: [
          {
            format: "clap",
            path: "/p/Synth.clap",
            name: "Synth",
            vendor: "",
            version: "",
            hasGui: true,
            instrument: true,
          },
          {
            format: "vst3",
            path: "/p/Delay.vst3",
            name: "Delay",
            vendor: "",
            version: "",
            hasGui: true,
          },
        ],
        skipped: [],
      }),
    });
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <InstrumentPicker instrument={undefined} onChange={onChange} />,
    );
    await user.click(screen.getByRole("button", { name: "Instrument: Acoustic Grand Piano" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "General MIDI sound" }), "33");
    expect(onChange).toHaveBeenLastCalledWith({ type: "soundfont", program: 33, bank: 0 });
    await user.click(screen.getByRole("button", { name: "Instrument: Acoustic Grand Piano" }));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Imported kit" }), "k1");
    expect(onChange).toHaveBeenLastCalledWith({ type: "kit", kitId: "k1" });
    await user.click(screen.getByRole("button", { name: "Instrument: Acoustic Grand Piano" }));
    await user.click(screen.getByRole("button", { name: "Find VST3 and CLAP instruments" }));
    const plugins = await screen.findByRole("combobox", { name: "Instrument plugin" });
    expect(within(plugins).queryByText(/Delay/)).toBeNull();
    await user.selectOptions(plugins, "/p/Synth.clap");
    expect(onChange).toHaveBeenLastCalledWith({
      type: "plugin",
      format: "clap",
      path: "/p/Synth.clap",
      name: "Synth",
    });
  });

  it("opens the pad board for a pad bank", async () => {
    mockTauri({ kits_list: () => [] });
    const onChange = vi.fn();
    const onEditPads = vi.fn();
    const { user } = renderWithProviders(
      <InstrumentPicker
        instrument={{ type: "drums" }}
        onChange={onChange}
        onEditPads={onEditPads}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Instrument: Drum kit" }));
    await user.click(screen.getByRole("button", { name: "Pad bank…" }));
    expect(onChange).toHaveBeenCalledWith({ type: "pads", pads: [] });
    expect(onEditPads).toHaveBeenCalled();
  });
});

describe("useMidiLaneInput", () => {
  it("arms the lane, plays the computer keyboard and on-screen hits, and passes on controls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = mockTauri();
    storeMidiPrefs({ ...DEFAULT_MIDI_PREFS, computerKeyboard: true, padVelocity: 90 });
    const onControl = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMidiLaneInput({
        armedLaneId: "lane",
        engineOn: true,
        ensureEngine: () => true,
        onControl,
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "audio_midi_arm")?.args).toEqual({ lane: "lane" }),
    );
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyUp(window, { key: "a" });
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "midi_inject").map((c) => c.args)).toEqual([
        { messages: [[0x90, 72, 90]] },
        { messages: [[0x80, 72, 0]] },
      ]),
    );
    act(() => result.current.hitDrum(38));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(
      calls
        .filter((c) => c.cmd === "midi_inject")
        .slice(-2)
        .map((c) => c.args),
    ).toEqual([{ messages: [[0x99, 38, 90]] }, { messages: [[0x89, 38, 0]] }]);
    await act(() => emit("midi://control", { action: "playPause", value: null, relative: false }));
    await waitFor(() =>
      expect(onControl).toHaveBeenCalledWith(expect.objectContaining({ action: "playPause" })),
    );
    unmount();
    vi.useRealTimers();
  });
});
