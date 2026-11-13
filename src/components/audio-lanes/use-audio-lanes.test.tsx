import { act } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  sourceLocations,
  useAudioLanes,
  type AudioLanesController,
  type SourceLoader,
} from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioLanesSettings, MixerSettings, SourceInfo } from "@/lib/tauri";
import { mockTauri } from "@/test/tauri";
import { renderWithProviders } from "@/test/render";

const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const SOURCE = {
  id: "a".repeat(64),
  name: "take.wav",
  ext: "wav",
  path: "/music/take.wav",
  embedded: false,
};

const info = (id: string, durationMs = 300_000): SourceInfo => ({
  id,
  name: "song.mp3",
  ext: "mp3",
  durationMs,
  sampleRate: 44_100,
  channels: 2,
  peaks: [0.5, 0.9],
  peaksPerSecond: 1,
});

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;

function Lanes({
  audio,
  loadSource,
  epoch,
}: {
  audio?: AudioLanesSettings;
  loadSource?: SourceLoader;
  epoch?: number | null;
}) {
  const [mix, setMix] = useState<MixerSettings>({ version: 3, master: 1, tracks: [], audio });
  const lanes = useAudioLanes({
    mix,
    changeMix: (action) => setMix((m) => mixerReducer(m, action)),
    loadSource,
    epoch,
    songPath: null,
    grid,
  });
  useEffect(() => {
    latest.lanes = lanes;
  });
  return null;
}

const withSource = (): AudioLanesSettings => ({
  ...EMPTY_AUDIO,
  sources: [SOURCE],
  lanes: [
    {
      ...newLane("Vocals", "lane-a"),
      clips: [newClip(SOURCE.id, "take.wav", 0, 4000, "clip-a")],
    },
  ],
});

describe("useAudioLanes without an audio engine", () => {
  it("opens a file with the file-level command, whatever the engine, on the first try", async () => {
    const calls = mockTauri({ audio_load_source: () => info("b".repeat(64)) });
    renderWithProviders(<Lanes />);
    await act(async () => lanesNow().importFiles(["/music/song.mp3"]));
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: "audio_load_source",
        args: { location: { type: "file", path: "/music/song.mp3" } },
      }),
    );
    expect(lanesNow().audio.lanes).toHaveLength(1);
    // The whole file, not cut to the score; its peaks are there for the waveform.
    expect(lanesNow().audio.lanes[0]!.clips[0]!.lengthMs).toBe(300_000);
    expect(lanesNow().infos.get("b".repeat(64))?.peaks).toEqual([0.5, 0.9]);
  });

  it("loads the files a song's lanes play when it opens (waveforms), once", async () => {
    const calls = mockTauri({ audio_load_source: () => info(SOURCE.id, 4000) });
    renderWithProviders(<Lanes audio={withSource()} />);
    await vi.waitFor(() => expect(lanesNow().infos.get(SOURCE.id)).toBeDefined());
    expect(lanesNow().missing.size).toBe(0);
    expect(calls.filter((c) => c.cmd === "audio_load_source")).toHaveLength(1);
  });

  it("marks a file that cannot be opened as missing", async () => {
    mockTauri({
      audio_load_source: () => {
        throw { kind: "not-found", message: "gone" };
      },
    });
    renderWithProviders(<Lanes audio={withSource()} />);
    await vi.waitFor(() => expect(lanesNow().missing.has(SOURCE.id)).toBe(true));
  });

  it("uses the loader it is given, and loads again into a new native engine", async () => {
    const loadSource = vi.fn(async () => info(SOURCE.id, 4000));
    const { rerender } = renderWithProviders(
      <Lanes audio={withSource()} loadSource={loadSource} epoch={null} />,
    );
    await vi.waitFor(() => expect(lanesNow().infos.get(SOURCE.id)).toBeDefined());
    expect(loadSource).toHaveBeenCalledTimes(1);
    // No new engine: nothing to do again.
    rerender(<Lanes audio={withSource()} loadSource={loadSource} epoch={null} />);
    expect(loadSource).toHaveBeenCalledTimes(1);
    // A native engine appears (epoch 1): it learns the file; the waveform stays meanwhile.
    rerender(<Lanes audio={withSource()} loadSource={loadSource} epoch={1} />);
    expect(lanesNow().infos.get(SOURCE.id)).toBeDefined();
    await vi.waitFor(() => expect(loadSource).toHaveBeenCalledTimes(2));
    // The same engine again: no more loads.
    rerender(<Lanes audio={withSource()} loadSource={loadSource} epoch={1} />);
    expect(loadSource).toHaveBeenCalledTimes(2);
  });
});

describe("sourceLocations", () => {
  const source = { id: "a".repeat(64), name: "Drums - Song.wav", ext: "wav", embedded: true };

  it("asks the loaded copy last, for a file no song file has yet", () => {
    expect(sourceLocations(source, null)).toEqual([
      { type: "pool", id: source.id, name: "Drums - Song.wav" },
    ]);
    expect(sourceLocations({ ...source, path: "/music/drums.wav" }, "/songs/riff.gp")).toEqual([
      { type: "file", path: "/music/drums.wav" },
      { type: "embedded", scorePath: "/songs/riff.gp", entry: `${source.id}.wav` },
      { type: "pool", id: source.id, name: "Drums - Song.wav" },
    ]);
  });

  it("has no loaded copy to ask for a file that is only referenced", () => {
    expect(sourceLocations({ ...source, embedded: false, path: "/music/take.wav" }, null)).toEqual([
      { type: "file", path: "/music/take.wav" },
    ]);
  });
});
