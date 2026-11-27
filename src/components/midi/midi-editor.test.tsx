import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { MidiEditor } from "@/components/midi/midi-editor";
import { activeMidiTake } from "@/lib/audio-lanes/midi";
import { EMPTY_AUDIO, newMidiClip, newMidiLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioLanesSettings, LaneInstrument, MidiNote, MixerSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

/** Eight bars of 4/4 at 120 bpm (a sixteenth is 125 ms). */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};

const note = (
  id: string,
  startMs: number,
  pitch: number,
  extra: Partial<MidiNote> = {},
): MidiNote => ({
  id,
  startMs,
  lenMs: 250,
  pitch,
  vel: 100,
  chan: 0,
  ...extra,
});

function song(instrument: LaneInstrument, notes: MidiNote[]): AudioLanesSettings {
  const lane = newMidiLane("Keys", instrument, "lane");
  return {
    ...EMPTY_AUDIO,
    lanes: [{ ...lane, clips: [newMidiClip("Riff", 0, 4000, { notes }, "clip")] }],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const notesNow = () => activeMidiTake(latest.lanes!.audio.lanes[0]!.clips[0]!).notes;

function Editor({ audio }: { audio: AudioLanesSettings }) {
  const [mix, setMix] = useState<MixerSettings>({ version: 4, master: 1, tracks: [], audio });
  const lanes = useAudioLanes({
    mix,
    changeMix: (action) => setMix((m) => mixerReducer(m, action)),
    loadSource: () => new Promise(() => {}),
    songPath: null,
    grid,
  });
  useEffect(() => {
    latest.lanes = lanes;
  });
  const lane = lanes.audio.lanes[0]!;
  return (
    <MidiEditor
      lanes={lanes}
      lane={lane}
      index={0}
      grid={grid}
      onClose={() => {}}
      onEffects={() => {}}
    />
  );
}

const renderEditor = (instrument: LaneInstrument, notes: MidiNote[]) =>
  renderWithProviders(<Editor audio={song(instrument, notes)} />);

describe("MidiEditor", () => {
  it("shows the notes in the piano roll with the keys and a velocity lane, and passes axe", async () => {
    renderEditor({ type: "soundfont", program: 0, bank: 0 }, [
      note("a", 0, 60),
      note("b", 500, 64),
    ]);
    expect(screen.getByRole("region", { name: "MIDI editor: Keys" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Piano roll" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("midi-note-a")).toHaveAttribute("data-pitch", "60");
    expect(screen.getByRole("application", { name: "Velocity lane" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Instrument: Acoustic Grand Piano" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("opens a drum lane on the drum grid with drum names", () => {
    renderEditor({ type: "drums" }, [note("k", 0, 36, { chan: 9 })]);
    expect(screen.getByRole("radio", { name: "Drum grid" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      within(screen.getByTestId("midi-keys")).getAllByText("Kick (hit)").length,
    ).toBeGreaterThan(0);
  });

  it("draws a note where the pointer presses, snapped to the grid, as one undo step", () => {
    renderEditor({ type: "soundfont", program: 0, bank: 0 }, []);
    const roll = screen.getByRole("application", { name: "Note grid" });
    // The view starts at 0 ms with 0.15 px/ms: x 160 is 1067 ms, snapped to 1000 ms (a 1/16 line).
    // Row 67 (from the top, 14 px rows) is pitch 60.
    fireEvent.pointerDown(roll, { button: 0, clientX: 155, clientY: 67 * 14 + 5, pointerId: 1 });
    fireEvent.pointerUp(roll, { button: 0, clientX: 155, clientY: 67 * 14 + 5, pointerId: 1 });
    expect(notesNow()).toHaveLength(1);
    expect(notesNow()[0]).toMatchObject({ startMs: 1000, pitch: 60, lenMs: 125 });
    act(() => latest.lanes!.undo());
    expect(notesNow()).toHaveLength(0);
  });

  it("selects everything with the keyboard, transposes, mutes and deletes", () => {
    renderEditor({ type: "soundfont", program: 0, bank: 0 }, [
      note("a", 0, 60),
      note("b", 500, 62),
    ]);
    const editor = screen.getByRole("region", { name: "MIDI editor: Keys" });
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "ArrowUp", shiftKey: true });
    expect(notesNow().map((n) => n.pitch)).toEqual([72, 74]);
    fireEvent.keyDown(editor, { key: "m" });
    expect(notesNow().every((n) => n.muted)).toBe(true);
    fireEvent.keyDown(editor, { key: "Delete" });
    expect(notesNow()).toEqual([]);
  });

  it("quantizes with the dialog, keeps the played timing, and unquantizes", async () => {
    const { user } = renderEditor({ type: "soundfont", program: 0, bank: 0 }, [note("a", 140, 60)]);
    await user.click(screen.getByRole("button", { name: "Quantize…" }));
    const dialog = await screen.findByRole("dialog", { name: "Quantize" });
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Quantize" }));
    expect(notesNow()[0]).toMatchObject({ startMs: 125, rawStartMs: 140 });
    await user.click(screen.getByRole("button", { name: "Unquantize" }));
    expect(notesNow()[0]!.startMs).toBe(140);
  });

  it("transposes by an octave with the dialog", async () => {
    const { user } = renderEditor({ type: "soundfont", program: 0, bank: 0 }, [note("a", 0, 60)]);
    await user.click(screen.getByRole("button", { name: "Transpose…" }));
    const dialog = await screen.findByRole("dialog", { name: "Transpose" });
    await user.click(within(dialog).getByRole("radio", { name: "Octave up" }));
    await user.click(within(dialog).getByRole("button", { name: "Transpose" }));
    expect(notesNow()[0]!.pitch).toBe(72);
  });

  it("edits a note's velocity in the event list", async () => {
    const { user } = renderEditor({ type: "soundfont", program: 0, bank: 0 }, [note("a", 0, 60)]);
    await user.click(screen.getByRole("radio", { name: "Event list" }));
    const velocity = screen.getByRole("textbox", { name: /Velocity of the note at 1\.1/ });
    await user.clear(velocity);
    await user.type(velocity, "40{Enter}");
    expect(notesNow()[0]!.vel).toBe(40);
    await expectNoA11yViolations();
  });

  it("changes the lane's instrument", async () => {
    const { user } = renderEditor({ type: "soundfont", program: 0, bank: 0 }, []);
    await user.click(screen.getByRole("button", { name: "Instrument: Acoustic Grand Piano" }));
    await user.click(await screen.findByRole("button", { name: "Drum kit" }));
    expect(latest.lanes!.audio.lanes[0]!.instrument).toEqual({ type: "drums" });
  });

  it("offers a new clip on a lane without one", async () => {
    const audio = { ...EMPTY_AUDIO, lanes: [newMidiLane("Empty", undefined, "lane")] };
    const { user } = renderWithProviders(<Editor audio={audio} />);
    await user.click(screen.getByRole("button", { name: "New MIDI clip" }));
    expect(latest.lanes!.audio.lanes[0]!.clips).toHaveLength(1);
  });
});
