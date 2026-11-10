import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { useRecordAudio } from "@/components/audio-lanes/use-record-audio";
import { EMPTY_AUDIO, MAX_LANES, newLane } from "@/lib/audio-lanes/model";

const recorder = vi.hoisted(() => {
  const state = { startedAt: 0 };
  return {
    state,
    cancel: vi.fn(),
    elapsed: vi.fn(() => 1),
    stop: vi.fn(async () => ({
      samples: new Float32Array(48_000 * 3),
      sampleRate: 48_000,
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
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));

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

function setup(laneCount = 0) {
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
      range: () => null,
      beatAt: () => ({ seconds: 0.5, beats: 4 }),
      speed: () => 1,
      ensureEngine: () => true,
    }),
  );
  return { ...hook, lanes };
}

describe("useRecordAudio", () => {
  beforeEach(() => vi.clearAllMocks());

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
});
