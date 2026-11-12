import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { useRecordAudio } from "@/components/audio-lanes/use-record-audio";
import { clipEndMs, EMPTY_AUDIO, MAX_LANES, MAX_TAKES, newLane } from "@/lib/audio-lanes/model";
import type { AudioLanesSettings } from "@/lib/tauri";

const recorder = vi.hoisted(() => {
  const state = { startedAt: 0, seconds: 3, sampleRate: 48_000 };
  return {
    state,
    cancel: vi.fn(),
    elapsed: vi.fn(() => 1),
    stop: vi.fn(async () => ({
      samples: new Float32Array(state.sampleRate * state.seconds),
      sampleRate: state.sampleRate,
      // The clock the hook times takes on: the take starts when the input opens, not at time 0.
      startedAt: state.startedAt,
      inputLatency: 0,
      capped: false,
    })),
  };
});
const startRecorder = vi.hoisted(() =>
  vi.fn(async () => {
    recorder.state.startedAt = performance.now();
    return recorder;
  }),
);
const addAudioTake = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/lib/audio/recorder", () => ({ startRecorder }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/tauri", async (original) => ({ ...(await original<object>()), addAudioTake }));

const grid = { barTimes: Array.from({ length: 8 }, (_, i) => i * 2000), beats: Array(8).fill(4) };
const transport = {
  seekToBar: vi.fn(),
  playPause: vi.fn(),
  pause: vi.fn(),
  setCountIn: vi.fn(),
  setLoop: vi.fn(),
  outputLatencySeconds: () => 0,
};

function setup(
  laneCount = 0,
  options: { speed?: number; range?: { start: number; end: number } | null } = {},
) {
  const lanes = {
    audio: {
      ...EMPTY_AUDIO,
      lanes: Array.from({ length: laneCount }, (_, i) => newLane(`L${i}`, `l${i}`)),
    },
    apply: vi.fn(),
  } as unknown as AudioLanesController;
  const hook = renderHook(() =>
    useRecordAudio({
      lanes,
      grid,
      transport: () => transport,
      startBar: () => 0,
      range: () => options.range ?? null,
      beatAt: () => ({ seconds: 0.5, beats: 4 }),
      speed: () => options.speed ?? 1,
      ensureEngine: () => true,
    }),
  );
  return { ...hook, lanes };
}

/** The clip the recording put on the first lane (what `lanes.apply` builds from an empty song). */
function recordedClip(lanes: AudioLanesController) {
  const update = vi.mocked(lanes.apply).mock.calls[0]![0] as (
    a: AudioLanesSettings,
  ) => AudioLanesSettings;
  return update(EMPTY_AUDIO).lanes[0]!.clips[0]!;
}

describe("useRecordAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recorder.state.seconds = 3;
    recorder.state.sampleRate = 48_000;
    addAudioTake.mockResolvedValue({ id: "take-1" });
  });

  it("opens the input once when Start is pressed twice", async () => {
    const { result } = setup();
    await act(async () => {
      result.current.start({ laneId: null, mode: "playhead", countIn: false, preRollBars: 0 });
      result.current.start({ laneId: null, mode: "playhead", countIn: false, preRollBars: 0 });
    });
    expect(startRecorder).toHaveBeenCalledTimes(1);
  });

  it("says the take was not kept when every lane is taken, and keeps no file", async () => {
    const { result, lanes } = setup(MAX_LANES);
    await act(async () =>
      result.current.start({ laneId: null, mode: "playhead", countIn: false, preRollBars: 0 }),
    );
    await act(async () => result.current.stop());
    expect(toast.error).toHaveBeenCalledWith("The take was not kept", expect.anything());
    expect(addAudioTake).not.toHaveBeenCalled();
    expect(lanes.apply).not.toHaveBeenCalled();
  });

  it("lets go of the input when it goes away mid-take", async () => {
    const { result, unmount } = setup();
    await act(async () =>
      result.current.start({ laneId: null, mode: "playhead", countIn: false, preRollBars: 0 }),
    );
    unmount();
    expect(recorder.cancel).toHaveBeenCalled();
  });

  it("maps a take recorded at half speed back onto the bars it covers", async () => {
    recorder.state.seconds = 6;
    const { result, lanes } = setup(0, { speed: 0.5, range: { start: 0, end: 0 } });
    await act(async () =>
      result.current.start({ laneId: null, mode: "punch", countIn: false, preRollBars: 0 }),
    );
    await act(async () => result.current.stop());
    const clip = recordedClip(lanes);
    // One 2 s bar took 4 s to play: 4 s of file, played at twice the rate, fills the bar.
    expect(clip.lengthMs).toBe(4000);
    expect(clip.playrate).toBe(2);
    expect(clipEndMs(clip) - clip.startMs).toBe(2000);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("keeps a loop recording within the take limit and says so", async () => {
    recorder.state.seconds = 140;
    recorder.state.sampleRate = 8000;
    const { result, lanes } = setup(0, { range: { start: 0, end: 0 } });
    await act(async () =>
      result.current.start({ laneId: null, mode: "loop", countIn: false, preRollBars: 0 }),
    );
    await act(async () => result.current.stop());
    const clip = recordedClip(lanes);
    expect(clip.takes).toHaveLength(MAX_TAKES);
    expect(clip.take).toBe(MAX_TAKES - 1);
    // The latest passes are the ones kept, so the last pass (about 70) is the one that plays.
    expect(Number(clip.takes.at(-1)!.name.replace("Pass ", ""))).toBeGreaterThan(MAX_TAKES);
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringMatching(/^Kept the last 64 of \d+ passes$/),
      expect.anything(),
    );
  });
});
