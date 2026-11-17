import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLaneToTab, useLaneTranscription } from "@/hooks/use-lane-to-tab";
import type { LanePart } from "@/lib/audio-lanes/lane-transcribe";
import { RECORDING_STOPPED } from "@/lib/tauri";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { appendMasterBar } from "@/lib/score/model";
import { createSong } from "@/lib/score/tracks";
import type * as TauriModule from "@/lib/tauri";
import { cancelLaneTranscription, transcribeLane } from "@/lib/tauri";
import { track } from "@/lib/telemetry";
import { seedAiState, resetAiStore, statusWith } from "@/lib/ai/ai-store";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof TauriModule>()),
  transcribeLane: vi.fn(),
  cancelLaneTranscription: vi.fn().mockResolvedValue(undefined),
}));

const part = (over: Partial<LanePart> = {}): LanePart => ({
  notes: [{ start: 1, end: 1.5, pitch: 40, velocity: 90 }],
  take: [{ start: 0.5, end: 1, pitch: 40, velocity: 90 }],
  originBar: 0,
  span: { startMs: 500, endMs: 4000 },
  instrument: "guitar",
  tuning: [...STANDARD_GUITAR],
  laneName: "Lead",
  ...over,
});

function envFor(blocked = false) {
  const score = createSong();
  while (score.masterBars.length < 4) appendMasterBar(score);
  const editor = {
    run: vi.fn((_label: string, targets: () => Iterable<object>, apply: () => void) => {
      void [...targets()];
      apply();
    }),
    structureTargets: vi.fn(() => [score]),
    placeCursorOnTrack: vi.fn(),
    undo: vi.fn(),
  };
  const onOpenScore = vi.fn();
  return { score, editor, onOpenScore, blocked: vi.fn(() => blocked) };
}

describe("useLaneToTab", () => {
  it("opens and closes with a new nonce for each opening", () => {
    const { result } = renderHook(() => useLaneToTab(envFor()));
    const request = { laneId: "l", clipIds: [], range: null, origin: "lane" as const };
    act(() => result.current.open(request));
    const first = result.current.nonce;
    expect(result.current.request).toEqual(request);
    act(() => result.current.close());
    expect(result.current.request).toBeNull();
    act(() => result.current.open(request));
    expect(result.current.nonce).toBeGreaterThan(first);
  });

  it("writes a part as one editor run on the chosen track and bar", () => {
    const env = envFor();
    const { result } = renderHook(() => useLaneToTab(env));
    let placed: ReturnType<typeof result.current.place> = null;
    act(() => {
      placed = result.current.place(part(), { track: 0, bar: 1 });
    });
    expect(env.editor.run).toHaveBeenCalledTimes(1);
    expect(env.editor.run.mock.calls[0]![0]).toBe("Add transcribed part");
    expect(env.editor.placeCursorOnTrack).toHaveBeenCalledWith(0);
    expect(placed).toMatchObject({ track: 0, firstBar: 1 });
    // One note in the song now, in bar 2.
    const bars = env.score.tracks[0]!.staves[0]!.bars;
    expect(bars[1]!.voices[0]!.beats.some((b) => b.notes.length > 0)).toBe(true);
  });

  it("writes nothing for a guest who may not edit", () => {
    const env = envFor(true);
    const { result } = renderHook(() => useLaneToTab(env));
    let placed: unknown = "x";
    act(() => {
      placed = result.current.place(part(), { track: 0, bar: 0 });
    });
    expect(placed).toBeNull();
    expect(env.editor.run).not.toHaveBeenCalled();
  });

  it("puts a part on a new track through the structure", () => {
    const env = envFor();
    const { result } = renderHook(() => useLaneToTab(env));
    act(() => {
      result.current.place(part(), { track: null, bar: 0 }, { toast: false });
    });
    expect(env.editor.structureTargets).toHaveBeenCalled();
    expect(env.score.tracks).toHaveLength(2);
  });

  it("opens a part as a new song named after the lane", () => {
    const env = envFor();
    const { result } = renderHook(() => useLaneToTab(env));
    const notes = Array.from({ length: 8 }, (_, i) => ({
      start: 1 + i * 0.5,
      end: 1.4 + i * 0.5,
      pitch: 40 + (i % 3),
      velocity: 90,
    }));
    act(() => {
      expect(result.current.newTab(part({ notes }))).toBe(true);
    });
    expect(env.onOpenScore).toHaveBeenCalledWith(expect.anything(), "Lead (sheet)");
  });
});

describe("useLaneTranscription", () => {
  beforeEach(() => {
    vi.mocked(transcribeLane).mockReset();
    vi.mocked(cancelLaneTranscription).mockClear();
    vi.mocked(track).mockClear();
    resetAiStore();
  });
  const input = {
    laneId: "l",
    clipId: "c",
    span: null,
    instrument: "piano" as const,
    engine: "standard" as const,
  };

  it("runs, counts it, and gives the span back", async () => {
    vi.mocked(transcribeLane).mockResolvedValue({
      notes: [{ start: 1, end: 2, pitch: 60, velocity: 80 }],
      startMs: 1000,
      endMs: 5000,
      clipIds: ["c"],
    });
    const { result } = renderHook(() => useLaneTranscription());
    let found: Awaited<ReturnType<typeof result.current.run>> = null;
    await act(async () => {
      found = await result.current.run(input);
    });
    expect(found).toMatchObject({ span: { startMs: 1000, endMs: 5000 } });
    expect(track).toHaveBeenCalledWith("lane_transcribe", "piano");
    expect(track).not.toHaveBeenCalledWith("ai_transcribe_file", expect.anything());
    expect(result.current.job.kind).toBe("idle");
  });

  it("counts MuScriptor for the rights counter", async () => {
    seedAiState({ ready: true, status: statusWith(["medium"]) });
    vi.mocked(transcribeLane).mockResolvedValue({ notes: [], startMs: 0, endMs: 1, clipIds: [] });
    const { result } = renderHook(() => useLaneTranscription());
    await act(async () => {
      await result.current.run({ ...input, engine: "muscriptor" });
    });
    expect(track).toHaveBeenCalledWith("ai_transcribe_file", expect.stringMatching(/rights_/));
  });

  it("reports a failure, and a stop as nothing", async () => {
    vi.mocked(transcribeLane).mockRejectedValueOnce({ kind: "empty", message: "No audio." });
    const { result } = renderHook(() => useLaneTranscription());
    await act(async () => {
      await result.current.run(input);
    });
    expect(result.current.job).toEqual({ kind: "failed", message: "No audio." });
    vi.mocked(transcribeLane).mockRejectedValueOnce(RECORDING_STOPPED);
    await act(async () => {
      await result.current.run(input);
    });
    expect(result.current.job.kind).toBe("idle");
  });

  it("stops the run when asked, and when the dialog goes away", async () => {
    let reject!: (error: unknown) => void;
    vi.mocked(transcribeLane).mockImplementation(
      () => new Promise((_resolve, fail) => (reject = fail)),
    );
    const { result, unmount } = renderHook(() => useLaneTranscription());
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run(input);
    });
    await waitFor(() => expect(result.current.job.kind).toBe("running"));
    act(() => result.current.stop());
    expect(cancelLaneTranscription).toHaveBeenCalledTimes(1);
    await act(async () => {
      reject(new Error("cancelled"));
      await run;
    });
    expect(result.current.job.kind).toBe("idle");
    // Going away while running stops it as well.
    vi.mocked(transcribeLane).mockImplementation(() => new Promise(() => {}));
    act(() => {
      void result.current.run(input);
    });
    unmount();
    expect(cancelLaneTranscription).toHaveBeenCalledTimes(2);
  });
});
