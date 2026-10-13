import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { useRecordToTab, recordTargets, type RecordEnv } from "@/hooks/use-record-to-tab";
import type { RecordSetup } from "@/components/score/record-dialog";
import { decodeTake } from "@/lib/audio/decode-take";
import { startRecorder } from "@/lib/audio/recorder";
import { alignOffset, recordingToSong, writeRecording } from "@/lib/import/recording";
import { transcribeRecording, cancelRecordingTranscription } from "@/lib/tauri";
import { track } from "@/lib/telemetry";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock("@/lib/audio/recorder", () => ({ startRecorder: vi.fn() }));
vi.mock("@/lib/audio/decode-take", () => ({ decodeTake: vi.fn() }));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
vi.mock("@/lib/import/recording", () => ({
  alignOffset: vi.fn(() => 0),
  recordingToSong: vi.fn(),
  recordingTargets: vi.fn(() => ["targets"]),
  writeRecording: vi.fn(() => ({ warnings: [] })),
}));
vi.mock("@/lib/score/tracks", () => ({
  createTrack: vi.fn(() => ({ name: "Recording" })),
  insertTrack: vi.fn(),
  uniqueTrackName: (_score: unknown, name: string) => name,
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauri: () => true,
  transcribeRecording: vi.fn(),
  cancelRecordingTranscription: vi.fn(async () => {}),
}));

const NOTE = { pitch: 40, velocity: 0.8 };
const TUNING = [64, 59, 55, 50, 45, 40];

const click = (over: Partial<RecordSetup> = {}): RecordSetup => ({
  mode: "click",
  track: 1,
  startBar: 2,
  playOthers: true,
  alignToBeat: true,
  tuning: TUNING,
  instrument: "guitar",
  ...over,
});

function fakePlayer() {
  return {
    setMetronome: vi.fn(),
    setCountIn: vi.fn(),
    setLoop: vi.fn(),
    seekToBar: vi.fn(),
    playPause: vi.fn(),
    pause: vi.fn(),
    outputLatencySeconds: vi.fn(() => 0.05),
  };
}

function fakeRecorder(
  take: Partial<Awaited<ReturnType<ReturnType<typeof fakeRecorderObject>["stop"]>>> = {},
) {
  const recorder = fakeRecorderObject(take);
  vi.mocked(startRecorder).mockResolvedValue(recorder);
  return recorder;
}
function fakeRecorderObject(take: Record<string, unknown> = {}) {
  return {
    elapsed: vi.fn(() => 3),
    stop: vi.fn(async () => ({
      samples: new Float32Array(48_000),
      sampleRate: 48_000,
      startedAt: 900,
      inputLatency: 0,
      capped: false,
      ...take,
    })),
    cancel: vi.fn(),
  };
}

function setup(over: Partial<RecordEnv> = {}) {
  const player = fakePlayer();
  const editor = {
    run: vi.fn((_label: string, targets: () => unknown, apply: () => void) => {
      targets();
      apply();
    }),
    structureTargets: vi.fn(() => []),
    placeCursorOnTrack: vi.fn(),
    undo: vi.fn(),
  };
  const score = {
    // 4/4 at 120 BPM: a beat is half a second, the count-in two seconds.
    masterBars: [0, 1, 2, 3].map(() => ({
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      tempoAutomations: [],
    })),
    tracks: [{ name: "Lead" }, { name: "Rhythm" }],
  };
  const setTrackStates = vi.fn();
  const onOpenScore = vi.fn();
  const env = {
    score,
    editor,
    player: () => player,
    ready: true,
    practice: () => ({ metronome: false, countIn: false, loop: null, speed: 100 }),
    mix: () => ({
      version: 1,
      master: 1,
      tracks: [
        { volume: 1, pan: 0, mute: false, solo: true },
        { volume: 1, pan: 0, mute: true, solo: false },
      ],
    }),
    setTrackStates,
    onOpenScore,
    ...over,
  } as unknown as RecordEnv;
  const hook = renderHook(() => useRecordToTab(env));
  return { ...hook, env, player, editor, score, setTrackStates, onOpenScore };
}

/** Starts a take and waits until it is recording. */
async function begin(hook: ReturnType<typeof setup>, choice: RecordSetup) {
  act(() => hook.result.current.start(choice));
  await waitFor(() => expect(startRecorder).toHaveBeenCalled());
  await act(async () => {});
}

async function stop(hook: ReturnType<typeof setup>) {
  act(() => hook.result.current.stop());
  await waitFor(() => expect(hook.result.current.phase.kind).toBe("idle"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(alignOffset).mockReturnValue(0);
  vi.mocked(writeRecording).mockReturnValue({ warnings: [] });
  vi.mocked(transcribeRecording).mockResolvedValue([{ start: 3.15, end: 3.5, ...NOTE }]);
});
afterEach(() => vi.restoreAllMocks());

describe("recordTargets", () => {
  it("lists the stringed and pitched tracks with their index", () => {
    expect(
      recordTargets([
        { name: "Drums", kind: "drums" },
        { name: "Lead", kind: "stringed" },
        { name: "Keys", kind: "pitched" },
        { name: "Bass", kind: "stringed" },
      ]),
    ).toEqual([
      { index: 1, name: "Lead", kind: "stringed" },
      { index: 2, name: "Keys", kind: "pitched" },
      { index: 3, name: "Bass", kind: "stringed" },
    ]);
  });
});

describe("click mode", () => {
  it("plays the song from the start bar with the click and a count-in", async () => {
    const hook = setup();
    fakeRecorder();
    await begin(hook, click());
    expect(hook.result.current.phase).toMatchObject({ kind: "recording", countingIn: true });
    expect(hook.player.pause).toHaveBeenCalled();
    expect(hook.player.setLoop).toHaveBeenCalledWith(null);
    expect(hook.player.setMetronome).toHaveBeenCalledWith(true);
    expect(hook.player.setCountIn).toHaveBeenCalledWith(true);
    expect(hook.player.seekToBar).toHaveBeenCalledWith(2);
    expect(hook.player.playPause).toHaveBeenCalledTimes(1);
  });

  it("mutes the target track, and nothing is soloed", async () => {
    const hook = setup();
    fakeRecorder();
    await begin(hook, click({ track: 1 }));
    expect(hook.setTrackStates).toHaveBeenLastCalledWith([
      { track: 0, mute: false, solo: false },
      { track: 1, mute: true, solo: false },
    ]);
  });

  it("mutes the other tracks too unless they should play", async () => {
    const hook = setup();
    fakeRecorder();
    await begin(hook, click({ playOthers: false }));
    expect(hook.setTrackStates).toHaveBeenLastCalledWith([
      { track: 0, mute: true, solo: false },
      { track: 1, mute: true, solo: false },
    ]);
  });

  it("puts the metronome, count-in, loop and mix back when the take ends", async () => {
    const hook = setup({
      practice: () => ({ metronome: false, countIn: true, loop: { start: 1, end: 2 }, speed: 100 }),
    });
    fakeRecorder();
    await begin(hook, click());
    await stop(hook);
    expect(hook.player.pause).toHaveBeenCalledTimes(2);
    expect(hook.player.setMetronome).toHaveBeenLastCalledWith(false);
    expect(hook.player.setCountIn).toHaveBeenLastCalledWith(true);
    expect(hook.player.setLoop).toHaveBeenLastCalledWith({ start: 1, end: 2 });
    expect(hook.setTrackStates).toHaveBeenLastCalledWith([
      { track: 0, mute: false, solo: true },
      { track: 1, mute: true, solo: false },
    ]);
  });

  it("writes the notes on the track in one undo step, with time 0 at the downbeat", async () => {
    // Playback starts at 1000 ms, the take's first sample is at 900 ms: the count-in (2 s) and
    // the output latency (50 ms) put the downbeat at 2.15 s in the take.
    vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.mocked(alignOffset).mockReturnValue(0.02);
    const hook = setup();
    fakeRecorder();
    await begin(hook, click());
    await stop(hook);

    expect(transcribeRecording).toHaveBeenCalledWith(
      expect.any(Float32Array),
      48_000,
      expect.any(Function),
      "guitar",
    );
    expect(hook.editor.run).toHaveBeenCalledTimes(1);
    expect(hook.editor.run.mock.calls[0]![0]).toBe("Record to tab");
    expect(writeRecording).toHaveBeenCalledTimes(1);
    const [, notes, options] = vi.mocked(writeRecording).mock.calls[0]!;
    expect(options).toEqual({ trackIndex: 1, startBar: 2 });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.start).toBeCloseTo(1.0 + 0.02, 6);
    expect(notes[0]!.end).toBeCloseTo(1.35 + 0.02, 6);
    // The grid it is fitted to is one beat: half a second at 120 BPM.
    expect(alignOffset).toHaveBeenCalledWith(expect.anything(), 0.5);
    expect(hook.editor.placeCursorOnTrack).toHaveBeenCalledWith(1);
    expect(track).toHaveBeenCalledWith("record_to_tab");
    expect(track).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Added your take to “Rhythm”",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
  });

  it("scales the notes of a take played at half speed", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.mocked(transcribeRecording).mockResolvedValue([{ start: 5.1, end: 5.6, ...NOTE }]);
    const hook = setup({
      practice: () => ({ metronome: false, countIn: false, loop: null, speed: 50 }),
    });
    fakeRecorder();
    await begin(hook, click());
    await stop(hook);
    // Count-in 4 s, +50 ms latency: the downbeat is at 4.15 s; 0.95 s later is 0.475 s of music.
    expect(vi.mocked(writeRecording).mock.calls[0]![1][0]!.start).toBeCloseTo(0.475, 6);
  });

  it("leaves the take where it was played when lining up with the beat is off", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.mocked(alignOffset).mockReturnValue(0.02);
    const hook = setup();
    fakeRecorder();
    await begin(hook, click({ alignToBeat: false }));
    await stop(hook);
    expect(alignOffset).not.toHaveBeenCalled();
    expect(vi.mocked(writeRecording).mock.calls[0]![1][0]!.start).toBeCloseTo(1.0, 6);
  });

  it("finds the track again when tracks moved during the transcription", async () => {
    const hook = setup();
    vi.mocked(transcribeRecording).mockImplementation(async () => {
      hook.score.tracks.shift();
      return [{ start: 3.15, end: 3.5, ...NOTE }];
    });
    fakeRecorder();
    await begin(hook, click({ track: 1 }));
    await stop(hook);
    expect(vi.mocked(writeRecording).mock.calls[0]![2]).toEqual({ trackIndex: 0, startBar: 2 });
    expect(toast).toHaveBeenCalledWith("Added your take to “Rhythm”", expect.anything());
  });

  it("adds nothing when the track was removed during the transcription", async () => {
    const hook = setup();
    vi.mocked(transcribeRecording).mockImplementation(async () => {
      hook.score.tracks.pop();
      return [{ start: 3.15, end: 3.5, ...NOTE }];
    });
    fakeRecorder();
    await begin(hook, click({ track: 1 }));
    await stop(hook);
    expect(hook.editor.run).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "The song changed while your take was transcribed",
      expect.anything(),
    );
  });

  it("adds nothing when the song was replaced during the transcription", async () => {
    const hook = setup();
    vi.mocked(transcribeRecording).mockImplementation(async () => {
      (hook.env as { score: unknown }).score = { ...hook.score, tracks: [...hook.score.tracks] };
      return [{ start: 3.15, end: 3.5, ...NOTE }];
    });
    fakeRecorder();
    await begin(hook, click());
    await stop(hook);
    expect(writeRecording).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "The song changed while your take was transcribed",
      expect.anything(),
    );
  });

  it("creates the new track inside the same undo step", async () => {
    const { createTrack, insertTrack } = await import("@/lib/score/tracks");
    const hook = setup();
    vi.mocked(insertTrack).mockImplementation((score, added) => void score.tracks.push(added));
    fakeRecorder();
    await begin(hook, click({ track: null, tuning: [64, 59, 55, 50, 45, 40, 35] }));
    await stop(hook);
    expect(hook.editor.run).toHaveBeenCalledTimes(1);
    expect(createTrack).toHaveBeenCalledWith(
      hook.score,
      expect.objectContaining({ kind: "stringed", tuning: [64, 59, 55, 50, 45, 40, 35] }),
    );
    expect(insertTrack).toHaveBeenCalled();
    expect(vi.mocked(writeRecording).mock.calls[0]![2]).toEqual({ trackIndex: 2, startBar: 2 });
  });

  it("shows what could not be written", async () => {
    vi.mocked(writeRecording).mockReturnValue({ warnings: ["Two notes were too fast."] });
    const hook = setup();
    fakeRecorder();
    await begin(hook, click());
    await stop(hook);
    expect(toast.warning).toHaveBeenCalledWith(
      "Your take was simplified",
      expect.objectContaining({ description: "Two notes were too fast." }),
    );
  });

  it("does not start when the song is not ready", async () => {
    const hook = setup({ ready: false });
    act(() => hook.result.current.start(click()));
    expect(startRecorder).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("The song is not ready yet", expect.anything());
    expect(hook.result.current.phase.kind).toBe("idle");
  });
});

describe("keys", () => {
  const press = (key: string) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });

  it("Escape in the count-in throws the take away", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const hook = setup();
    const recorder = fakeRecorder();
    await begin(hook, click());
    press("Escape");
    expect(recorder.cancel).toHaveBeenCalled();
    expect(hook.result.current.phase.kind).toBe("idle");
    expect(hook.player.setMetronome).toHaveBeenLastCalledWith(false);
    expect(transcribeRecording).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("Escape after the count-in stops the take and keeps it", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const hook = setup();
    const recorder = fakeRecorder();
    await begin(hook, click());
    now.mockReturnValue(3500);
    press("Escape");
    await waitFor(() => expect(transcribeRecording).toHaveBeenCalled());
    expect(recorder.cancel).not.toHaveBeenCalled();
    await waitFor(() => expect(writeRecording).toHaveBeenCalled());
  });

  it("Space stops the take, and the page does not get it", async () => {
    const hook = setup();
    fakeRecorder();
    await begin(hook, click({ track: 1 }));
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    const other = vi.fn();
    window.addEventListener("keydown", other);
    act(() => {
      window.dispatchEvent(event);
    });
    window.removeEventListener("keydown", other);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(transcribeRecording).toHaveBeenCalled());
  });

  it("does nothing with keys when no take is running", () => {
    setup();
    const event = new KeyboardEvent("keydown", { key: " ", cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("piano", () => {
  const highNote = { start: 3.15, end: 3.5, pitch: 72, velocity: 90 };
  const lowNote = { start: 3.15, end: 3.5, pitch: 40, velocity: 90 };

  it("asks the transcriber for piano settings and opens two hands as a new song", async () => {
    const song = { score: { title: "x" }, warnings: [] };
    vi.mocked(recordingToSong).mockReturnValue(song as never);
    vi.mocked(transcribeRecording).mockResolvedValue([highNote, lowNote] as never);
    const hook = setup();
    fakeRecorder();
    await begin(hook, click({ mode: "free", track: null, instrument: "piano" }));
    await stop(hook);
    expect(transcribeRecording).toHaveBeenCalledWith(
      expect.any(Float32Array),
      48_000,
      expect.any(Function),
      "piano",
    );
    expect(recordingToSong).toHaveBeenCalledWith(expect.anything(), {
      tuning: undefined,
      trackName: "Recording",
      program: 0,
    });
    expect(hook.onOpenScore).toHaveBeenCalledWith(song.score, "Recording");
  });

  it("writes a new piano take on a track for each hand, in one undo step", async () => {
    const { createTrack, insertTrack } = await import("@/lib/score/tracks");
    vi.mocked(createTrack).mockClear();
    vi.mocked(transcribeRecording).mockResolvedValue([highNote, lowNote] as never);
    const hook = setup();
    vi.mocked(insertTrack).mockImplementation((score, added) => void score.tracks.push(added));
    fakeRecorder();
    await begin(hook, click({ track: null, instrument: "piano" }));
    await stop(hook);
    expect(hook.editor.run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createTrack).mock.calls.map(([, spec]) => spec)).toEqual([
      expect.objectContaining({ kind: "pitched", name: "Recording", program: 0, bass: false }),
      expect.objectContaining({
        kind: "pitched",
        name: "Recording (left hand)",
        program: 0,
        bass: true,
      }),
    ]);
    const writes = vi.mocked(writeRecording).mock.calls;
    expect(writes.map(([, notes]) => notes.map((n) => n.pitch))).toEqual([[72], [40]]);
    expect(writes.map(([, , options]) => options.trackIndex)).toEqual([2, 3]);
    expect(hook.editor.placeCursorOnTrack).toHaveBeenCalledWith(2);
  });

  it("makes no track for a hand that played nothing", async () => {
    const { createTrack } = await import("@/lib/score/tracks");
    vi.mocked(createTrack).mockClear();
    vi.mocked(transcribeRecording).mockResolvedValue([highNote] as never);
    const hook = setup();
    fakeRecorder();
    await begin(hook, click({ track: null, instrument: "piano" }));
    await stop(hook);
    expect(createTrack).toHaveBeenCalledTimes(1);
  });
});

describe("free mode", () => {
  it("does not play the song, and opens the take as a new song", async () => {
    const song = { score: { title: "x" }, warnings: ["Tempo is a guess."] };
    vi.mocked(recordingToSong).mockReturnValue(song as never);
    const hook = setup();
    fakeRecorder();
    await begin(hook, click({ mode: "free", track: null, tuning: [62, 57, 53, 48, 43, 38] }));
    expect(hook.player.playPause).not.toHaveBeenCalled();
    expect(hook.player.setMetronome).not.toHaveBeenCalled();
    expect(hook.setTrackStates).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toMatchObject({ kind: "recording", countingIn: false });
    await stop(hook);

    expect(recordingToSong).toHaveBeenCalledWith(expect.anything(), {
      tuning: [62, 57, 53, 48, 43, 38],
      trackName: "Recording",
      program: 25,
    });
    expect(hook.onOpenScore).toHaveBeenCalledWith(song.score, "Recording");
    expect(hook.editor.run).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      "Your take was simplified",
      expect.objectContaining({ description: "Tempo is a guess." }),
    );
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("Escape stops a free take", async () => {
    const hook = setup();
    const recorder = fakeRecorder();
    await begin(hook, click({ mode: "free" }));
    vi.mocked(recordingToSong).mockReturnValue({ score: {}, warnings: [] } as never);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    await waitFor(() => expect(transcribeRecording).toHaveBeenCalled());
    expect(recorder.cancel).not.toHaveBeenCalled();
  });
});

describe("transcribing", () => {
  it("shows progress, and Cancel stops the transcription", async () => {
    let progress: (fraction: number) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    vi.mocked(transcribeRecording).mockImplementation(
      (_samples, _rate, onProgress) =>
        new Promise((_resolve, rej) => {
          progress = onProgress!;
          reject = rej;
        }),
    );
    const hook = setup();
    fakeRecorder();
    await begin(hook, click());
    act(() => hook.result.current.stop());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("transcribing"));
    act(() => progress(0.4));
    expect(hook.result.current.phase).toEqual({ kind: "transcribing", fraction: 0.4 });

    act(() => hook.result.current.cancel());
    expect(cancelRecordingTranscription).toHaveBeenCalled();
    await act(async () => reject("Transcription stopped."));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("idle"));
    expect(toast.info).toHaveBeenCalledWith("Transcription stopped", expect.anything());
    expect(writeRecording).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it("explains a microphone that is not allowed", async () => {
    vi.mocked(startRecorder).mockRejectedValue(new DOMException("no", "NotAllowedError"));
    const hook = setup();
    act(() => hook.result.current.start(click()));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't start recording",
      expect.objectContaining({ description: expect.stringContaining("Microphone") }),
    );
    expect(hook.result.current.phase.kind).toBe("idle");
    expect(hook.player.playPause).not.toHaveBeenCalled();
  });

  it("reports a transcription that failed, and changes nothing", async () => {
    vi.mocked(transcribeRecording).mockRejectedValue({ kind: "audio", message: "Broken model." });
    const hook = setup();
    fakeRecorder();
    await begin(hook, click());
    await stop(hook);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't turn your take into tab",
      expect.objectContaining({ description: "Broken model." }),
    );
    expect(hook.editor.run).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("reports a failed write, which leaves the song as it was", async () => {
    vi.mocked(writeRecording).mockImplementation(() => {
      throw new Error("Bar 9 is missing.");
    });
    const hook = setup();
    fakeRecorder();
    await begin(hook, click());
    await stop(hook);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't turn your take into tab",
      expect.objectContaining({ description: "Bar 9 is missing." }),
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("says when no note was heard", async () => {
    vi.mocked(transcribeRecording).mockResolvedValue([]);
    const hook = setup();
    fakeRecorder();
    await begin(hook, click());
    await stop(hook);
    expect(toast.info).toHaveBeenCalledWith("No notes were heard", expect.anything());
    expect(writeRecording).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("says that a take stopped at the limit, even when no note was heard", async () => {
    vi.mocked(transcribeRecording).mockResolvedValue([]);
    const hook = setup();
    fakeRecorder({ capped: true });
    await begin(hook, click());
    await stop(hook);
    expect(toast.info).toHaveBeenCalledWith(
      "The take reached the limit of 10 minutes and was stopped.",
    );
    expect(toast.info).toHaveBeenCalledWith("No notes were heard", expect.anything());
  });

  it("does not transcribe a take that is almost empty", async () => {
    const hook = setup();
    fakeRecorder({ samples: new Float32Array(100) });
    await begin(hook, click());
    await stop(hook);
    expect(toast.info).toHaveBeenCalledWith("Nothing was recorded", expect.anything());
    expect(transcribeRecording).not.toHaveBeenCalled();
  });

  it("ends the take when the song is closed", async () => {
    const hook = setup();
    const recorder = fakeRecorder();
    await begin(hook, click());
    hook.unmount();
    expect(recorder.cancel).toHaveBeenCalled();
    expect(hook.player.setMetronome).toHaveBeenLastCalledWith(false);
  });
});

describe("an existing recording", () => {
  const file = (name = "riff.wav") => new File([new Uint8Array(8)], name);

  it("decodes the file and opens its notes as a new song named after it", async () => {
    const song = { score: { title: "x" }, warnings: [] };
    vi.mocked(recordingToSong).mockReturnValue(song as never);
    vi.mocked(decodeTake).mockResolvedValue({
      samples: new Float32Array(22_050),
      sampleRate: 22_050,
    });
    const hook = setup();
    act(() => hook.result.current.open());
    act(() => hook.result.current.fromFile(file("Solo take.wav"), TUNING, "guitar"));
    expect(hook.result.current.dialogOpen).toBe(false);
    await waitFor(() => expect(hook.onOpenScore).toHaveBeenCalledWith(song.score, "Solo take"));
    expect(transcribeRecording).toHaveBeenCalledWith(
      expect.any(Float32Array),
      22_050,
      expect.any(Function),
      "guitar",
    );
    expect(recordingToSong).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tuning: TUNING }),
    );
    expect(transcribeRecording).toHaveBeenCalledWith(
      expect.anything(),
      22_050,
      expect.any(Function),
      "guitar",
    );
    expect(hook.player.playPause).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith("record_to_tab");
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("idle"));
  });

  it("reports a file that can't be read, and opens nothing", async () => {
    vi.mocked(decodeTake).mockRejectedValue(new Error("Couldn't read this file as audio."));
    const hook = setup();
    act(() => hook.result.current.fromFile(file(), TUNING, "guitar"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't turn this recording into tab",
        expect.objectContaining({ description: "Couldn't read this file as audio." }),
      ),
    );
    expect(transcribeRecording).not.toHaveBeenCalled();
    expect(hook.onOpenScore).not.toHaveBeenCalled();
  });
});

describe("the dialog", () => {
  it("opens for a track, and closes when the take starts", () => {
    const hook = setup();
    act(() => hook.result.current.open(1));
    expect(hook.result.current.dialogOpen).toBe(true);
    expect(hook.result.current.dialogTrack).toBe(1);
    fakeRecorder();
    act(() => hook.result.current.start(click()));
    expect(hook.result.current.dialogOpen).toBe(false);
  });
});
