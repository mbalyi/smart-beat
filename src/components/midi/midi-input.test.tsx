import { act, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import type { RecordTransport } from "@/components/audio-lanes/use-record-audio";
import { MidiArmedBar } from "@/components/midi/midi-armed-bar";
import { MidiSettings } from "@/components/midi/midi-settings";
import { PadBoardDialog } from "@/components/midi/pad-board-dialog";
import { useMidiRecord } from "@/components/midi/use-midi-record";
import { activeMidiTake } from "@/lib/audio-lanes/midi";
import { EMPTY_AUDIO, newMidiLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { DEFAULT_MIDI_PREFS, storeMidiPrefs } from "@/lib/midi/prefs";
import { mixerReducer } from "@/lib/score/mixer";
import type {
  AudioLanesSettings,
  MidiActivity,
  MidiDevice,
  MidiDeviceSettings,
  MixerSettings,
} from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const settings = (name: string, patch: Partial<MidiDeviceSettings> = {}): MidiDeviceSettings => ({
  name,
  alias: "",
  enabled: true,
  offsetMs: 0,
  controlOnly: false,
  channel: null,
  transpose: 0,
  fixedVelocity: null,
  padLayout: "grid16",
  pads: [],
  controls: [],
  ...patch,
});
const DEVICE: MidiDevice = {
  name: "Pad Controller",
  connected: true,
  settings: settings("Pad Controller"),
};

const hit = (number: number, kind: MidiActivity["kind"] = "note") =>
  act(() =>
    emit("midi://activity", {
      device: DEVICE.name,
      kind,
      chan: 9,
      number,
      value: 100,
      plays: number,
    } satisfies MidiActivity),
  );

beforeEach(() => {
  localStorage.clear();
});

describe("PadBoardDialog", () => {
  it("lights the pad that is hit, learns which note a pad sends and gives it a drum", async () => {
    const updates: MidiDeviceSettings[] = [];
    mockTauri({
      midi_devices: () => [DEVICE],
      midi_device_update: (args) => {
        updates.push((args as { settings: MidiDeviceSettings }).settings);
        return [DEVICE];
      },
    });
    const lane = newMidiLane("Pads", { type: "pads", pads: [] }, "lane");
    const onSave = vi.fn();
    const { user } = renderWithProviders(
      <PadBoardDialog open onOpenChange={() => {}} lane={lane} onSave={onSave} />,
    );
    const grid = await screen.findByRole("group", { name: "Pads" });
    expect(within(grid).getAllByRole("button")).toHaveLength(16);
    // The bottom-left cell is pad 1.
    expect(within(grid).getAllByRole("button")[12]).toHaveAccessibleName(/^Pad 1:/);
    await screen.findByRole("option", { name: "Pad Controller" });

    await hit(37);
    expect(
      within(screen.getByRole("button", { name: /^Pad 2:/ })).getByTestId("midi-activity-light"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Pad 2:/ }));
    await user.click(screen.getByRole("button", { name: "Learn: hit the pad" }));
    await hit(48);
    expect(screen.getByText("It sends note 48.")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Or a drum of the kit" }), "38");
    await expectNoA11yViolations(screen.getByRole("dialog"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ key: 37, drum: 38 })], []);
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]!.pads).toContainEqual({ from: 48, to: 37 });
  });

  it("says how to connect a controller when there is none", async () => {
    mockTauri({ midi_devices: () => [] });
    renderWithProviders(
      <PadBoardDialog open onOpenChange={() => {}} lane={null} onSave={() => {}} />,
    );
    expect(await screen.findByText(/No MIDI device is connected/)).toBeInTheDocument();
  });
});

describe("MidiArmedBar", () => {
  it("shows what it listens to, remembers the record choices and starts a take", async () => {
    mockTauri({ midi_devices: () => [DEVICE] });
    const onRecord = vi.fn();
    const { user } = renderWithProviders(
      <MidiArmedBar
        laneName="Drums"
        recording={false}
        onRecord={onRecord}
        onStop={() => {}}
        onCancel={() => {}}
        onDisarm={() => {}}
        onPadBoard={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(await screen.findByText("Listening to Pad Controller")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Record mode" }), "overdub");
    await user.click(screen.getByRole("switch", { name: "Quantize to 1/16" }));
    expect(JSON.parse(localStorage.getItem("smart-beat:midi-record")!)).toMatchObject({
      mode: "overdub",
      inputQuantize: true,
    });
    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(onRecord).toHaveBeenCalled();
    await expectNoA11yViolations();
  });
});

describe("MidiSettings", () => {
  it("lists devices and learns a knob for an app control", async () => {
    const updates: MidiDeviceSettings[] = [];
    mockTauri({
      midi_devices: () => [DEVICE],
      midi_device_update: (args) => {
        const s = (args as { settings: MidiDeviceSettings }).settings;
        updates.push(s);
        return [{ ...DEVICE, settings: s }];
      },
    });
    const { user } = renderWithProviders(<MidiSettings />);
    expect(
      await screen.findByRole("region", { name: "MIDI device Pad Controller" }),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Action to learn for Pad Controller" }),
      "laneVolume",
    );
    await user.click(screen.getByRole("button", { name: "Learn" }));
    await hit(20, "cc");
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]!.controls).toEqual([
      { source: "cc", chan: 9, number: 20, action: "laneVolume", relative: false },
    ]);
    expect(
      await screen.findByText(/Knob CC 20 on channel 10 → Armed lane volume/),
    ).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("explains Bluetooth pairing when nothing is connected", async () => {
    mockTauri({ midi_devices: () => [] });
    renderWithProviders(<MidiSettings />);
    expect(await screen.findByText(/Audio MIDI Setup/)).toBeInTheDocument();
  });
});

// --- Recording ---------------------------------------------------------------------------

const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const latest: {
  lanes: AudioLanesController | null;
  record: ReturnType<typeof useMidiRecord> | null;
} = {
  lanes: null,
  record: null,
};
const transport: RecordTransport = {
  seekToBar: vi.fn(),
  playPause: vi.fn(),
  pause: vi.fn(),
  setCountIn: vi.fn(),
  setLoop: vi.fn(),
  outputLatencySeconds: () => 0.02,
};

function Recorder({ audio }: { audio: AudioLanesSettings }) {
  const [mix, setMix] = useState<MixerSettings>({ version: 4, master: 1, tracks: [], audio });
  const lanes = useAudioLanes({
    mix,
    changeMix: (action) => setMix((m) => mixerReducer(m, action)),
    loadSource: () => new Promise(() => {}),
    songPath: null,
    grid,
  });
  const record = useMidiRecord({
    lanes,
    grid,
    transport: () => transport,
    startBar: () => 1,
    range: () => null,
    ensureEngine: () => true,
  });
  useEffect(() => {
    latest.lanes = lanes;
    latest.record = record;
  });
  return null;
}

describe("useMidiRecord", () => {
  it("plays from the playhead, then puts what was played on the lane in one undo step", async () => {
    storeMidiPrefs({ ...DEFAULT_MIDI_PREFS, preRollBars: 0, countIn: false });
    const calls = mockTauri({
      midi_record_start: () => null,
      audio_midi_panic: () => null,
      midi_record_stop: () => [
        { ms: 2100, status: 0x99, d1: 36, d2: 110 },
        { ms: 2200, status: 0x89, d1: 36, d2: 0 },
        { ms: 2500, status: 0x99, d1: 38, d2: 90 },
      ],
    });
    const audio = { ...EMPTY_AUDIO, lanes: [newMidiLane("Drums", { type: "drums" }, "lane")] };
    renderWithProviders(<Recorder audio={audio} />);
    await act(async () => latest.record!.start("lane"));
    expect(calls.find((c) => c.cmd === "midi_record_start")?.args).toEqual({ latencyMs: 20 });
    expect(transport.seekToBar).toHaveBeenCalledWith(1);
    expect(latest.record!.recording).toBe("lane");
    await act(async () => latest.record!.stop());
    await waitFor(() => expect(latest.lanes!.audio.lanes[0]!.clips).toHaveLength(1));
    const clip = latest.lanes!.audio.lanes[0]!.clips[0]!;
    expect(clip.startMs).toBe(2100);
    expect(activeMidiTake(clip).notes.map((n) => [n.startMs, n.pitch, n.vel])).toEqual([
      [0, 36, 110],
      [400, 38, 90],
    ]);
    expect(calls.some((c) => c.cmd === "audio_midi_panic")).toBe(true);
    act(() => latest.lanes!.undo());
    expect(latest.lanes!.audio.lanes[0]!.clips).toHaveLength(0);
  });

  it("throws a take away on discard", async () => {
    mockTauri({
      midi_record_start: () => null,
      audio_midi_panic: () => null,
      midi_record_stop: () => [{ ms: 2100, status: 0x99, d1: 36, d2: 110 }],
    });
    const audio = { ...EMPTY_AUDIO, lanes: [newMidiLane("Drums", { type: "drums" }, "lane")] };
    renderWithProviders(<Recorder audio={audio} />);
    await act(async () => latest.record!.start("lane"));
    await act(async () => latest.record!.discard());
    expect(latest.lanes!.audio.lanes[0]!.clips).toHaveLength(0);
    expect(latest.record!.recording).toBeNull();
  });
});
