import { describe, expect, it } from "vitest";

import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import { defaultEffect } from "@/lib/audio/effects";
import { describeLiveInput, withLiveInput } from "@/lib/audio/lane-monitor";
import { DEFAULT_MONITOR } from "@/lib/audio/monitor";
import { heardMix, initialMix, isAudible, isMonitorAudible } from "@/lib/score/mixer";
import type { AudioLane, MixerSettings, MonitorStatus } from "@/lib/tauri";
import { SUMMARY } from "@/test/score";

const reverb = defaultEffect("reverb");

/** A song with two audio lanes (the first has a clip and a reverb) and one track. */
function song(change: (lanes: AudioLane[]) => AudioLane[] = (l) => l): MixerSettings {
  const guitar: AudioLane = {
    ...newLane("Guitar", "guitar"),
    volume: 0.6,
    pan: -0.3,
    effects: [reverb],
    clips: [newClip("src", "take.wav", 0, 2000)],
  };
  const backing: AudioLane = {
    ...newLane("Backing", "backing"),
    clips: [newClip("src2", "backing.wav", 0, 2000)],
  };
  return {
    ...initialMix(SUMMARY, null),
    audio: { ...EMPTY_AUDIO, lanes: change([guitar, backing]) },
  };
}

const live = { laneId: "guitar", hear: true, silence: false };

describe("withLiveInput", () => {
  it("leaves the mix alone without a live input", () => {
    const mix = song();
    expect(withLiveInput(mix, null)).toBe(mix);
  });

  it("plays the input on the monitor track with the armed lane's effects, level and pan", () => {
    const mix = withLiveInput(song(), live);
    expect(mix.monitor).toMatchObject({
      enabled: true,
      volume: 0.6,
      pan: -0.3,
      mute: false,
      effects: [reverb],
    });
  });

  it("does not save anything: the song's own monitor track is untouched", () => {
    const own = { ...DEFAULT_MONITOR, volume: 0.3, effects: [defaultEffect("delay")] };
    const mix = { ...song(), monitor: own };
    withLiveInput(mix, live);
    expect(mix.monitor).toBe(own);
    // Not heard (switched off or no input to hear): the song's own monitor track plays as it was.
    expect(withLiveInput(mix, { ...live, hear: false }).monitor).toBe(own);
  });

  it("follows the lane's effects while it is armed", () => {
    const mix = song((lanes) => lanes.map((l) => ({ ...l, effects: [] })));
    expect(withLiveInput(mix, live).monitor?.effects).toEqual([]);
  });

  it("keeps the armed lane's clips out of the engine while a take is recorded", () => {
    const mix = withLiveInput(song(), { ...live, silence: true });
    const lanes = mix.audio!.lanes;
    expect(lanes.find((l) => l.id === "guitar")!.clips).toEqual([]);
    expect(lanes.find((l) => l.id === "backing")!.clips).toHaveLength(1);
  });

  it("keeps the clips while the lane is only armed", () => {
    const mix = withLiveInput(song(), live);
    expect(mix.audio!.lanes.find((l) => l.id === "guitar")!.clips).toHaveLength(1);
  });

  it("ignores a lane that is gone or a folder", () => {
    const mix = song();
    expect(withLiveInput(mix, { ...live, laneId: "gone", silence: true })).toBe(mix);
    const folder = song((lanes) => lanes.map((l) => ({ ...l, folder: true })));
    expect(withLiveInput(folder, live)).toBe(folder);
  });

  describe("play along while recording", () => {
    it("lets the other lanes and tracks sound as they do in normal playback", () => {
      const mix = withLiveInput(song(), { ...live, silence: true });
      expect(isAudible(mix, 0)).toBe(true);
      expect(isMonitorAudible(mix)).toBe(true);
      expect(mix.audio!.lanes.find((l) => l.id === "backing")).toMatchObject({
        mute: false,
        solo: false,
      });
    });

    it("keeps a muted lane silent", () => {
      const muted = song((lanes) =>
        lanes.map((l) => (l.id === "backing" ? { ...l, mute: true } : l)),
      );
      const mix = withLiveInput(muted, { ...live, silence: true });
      expect(mix.audio!.lanes.find((l) => l.id === "backing")!.mute).toBe(true);
    });

    it("plays only what is soloed, and the input with it", () => {
      const soloed = song((lanes) =>
        lanes.map((l) => (l.id === "backing" ? { ...l, solo: true } : l)),
      );
      const mix = withLiveInput(soloed, { ...live, silence: true });
      // The input is soloed with the lane, so it is heard; the track is not.
      expect(mix.monitor?.solo).toBe(true);
      expect(isMonitorAudible(mix)).toBe(true);
      expect(isAudible(mix, 0)).toBe(false);
    });

    it("lets the input be heard when the recorded lane itself is soloed", () => {
      const soloed = song((lanes) =>
        lanes.map((l) => (l.id === "guitar" ? { ...l, solo: true } : l)),
      );
      const mix = withLiveInput(soloed, { ...live, silence: true });
      expect(isMonitorAudible(mix)).toBe(true);
      expect(mix.audio!.lanes.find((l) => l.id === "guitar")!.clips).toEqual([]);
    });

    it("works on top of the practice mode (hear only me)", () => {
      const heard = heardMix({ ...song(), focus: 0, focusMode: "onlyMe" });
      expect(withLiveInput(heard, live).monitor?.enabled).toBe(true);
    });
  });
});

describe("describeLiveInput", () => {
  const status: MonitorStatus = {
    open: true,
    device: "Scarlett 2i2",
    channels: 2,
    sampleRate: 48_000,
    latencyMs: 11.4,
    error: null,
  };
  const base = {
    hear: true,
    engineOn: true,
    inputName: "Scarlett 2i2",
    channel: 0 as number | null,
    status,
  };

  it("names the device, the input and the delay", () => {
    expect(describeLiveInput(base)).toEqual({
      text: "Scarlett 2i2, input 1 · about 11 ms delay",
      problem: false,
    });
  });

  it("says all inputs when they are mixed", () => {
    expect(describeLiveInput({ ...base, channel: null }).text).toContain("all inputs");
  });

  it("says why the input is not heard: off, no native engine, an error, still opening", () => {
    expect(describeLiveInput({ ...base, hear: false })).toEqual({
      text: "Scarlett 2i2, input 1 · not heard",
      problem: false,
    });
    expect(describeLiveInput({ ...base, engineOn: false }).problem).toBe(true);
    expect(describeLiveInput({ ...base, status: { ...status, error: "Device is gone" } })).toEqual({
      text: "Device is gone",
      problem: true,
    });
    expect(describeLiveInput({ ...base, status: null }).text).toBe("Opening Scarlett 2i2…");
  });
});
