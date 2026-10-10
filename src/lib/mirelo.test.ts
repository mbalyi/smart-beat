import { invoke } from "@tauri-apps/api/core";
import { mireloProvider, waitForMirelo, withAbort } from "./mirelo";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/lib/audio-transcription/duration", () => ({
  audioDurationMs: vi.fn().mockResolvedValue(3000),
}));
const quote = { assetId: "one", durationMs: 3000, credits: 8, estimatedMs: 1000 };
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
});
it("polls the same job, reports provider progress and returns exact MIDI bytes", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke)
    .mockResolvedValueOnce({ status: "processing", percent: 30 })
    .mockResolvedValueOnce({
      status: "succeeded",
      result: { midiBase64: "TVRoZA==", notes: [], durationSeconds: 3, model: "audio-to-midi" },
    });
  const onProgress = vi.fn();
  const pending = waitForMirelo(quote, { signal: new AbortController().signal, onProgress });
  await vi.advanceTimersByTimeAsync(2000);
  expect((await pending).midi).toEqual(new Uint8Array([77, 84, 104, 100]));
  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ percent: 30 }));
  expect(vi.mocked(invoke).mock.calls.map(([cmd]) => cmd)).toEqual(["poll_audio", "poll_audio"]);
});
it("bounds waiting without resubmitting a paid create", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.mocked(invoke).mockImplementation(async () => {
    vi.setSystemTime(600_000);
    return { status: "processing" };
  });
  const pending = waitForMirelo(quote, {
    signal: new AbortController().signal,
    onProgress: vi.fn(),
  });
  const assertion = expect(pending).rejects.toThrow("longer than expected");
  await vi.advanceTimersByTimeAsync(2000);
  await assertion;
  expect(invoke).toHaveBeenCalledOnce();
});
it("allows local cancellation while an IPC call is still pending", async () => {
  const controller = new AbortController();
  let resolve!: (value: number) => void;
  const pending = withAbort(
    new Promise<number>((r) => {
      resolve = r;
    }),
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  resolve(1);
});
it("sends the audio type in its own header: Tauri overwrites Content-Type for raw bodies", async () => {
  vi.mocked(invoke).mockResolvedValue(quote);
  const file = new File(["mp3"], "Song.MP3");
  await mireloProvider.quote(file, { signal: new AbortController().signal, onProgress: vi.fn() });
  const [command, body, options] = vi.mocked(invoke).mock.calls[0]!;
  expect(command).toBe("quote_audio");
  expect(body).toEqual(new Uint8Array(new TextEncoder().encode("mp3")));
  expect(options?.headers).toEqual(expect.objectContaining({ "audio-type": "audio/mpeg" }));
  expect(options?.headers).not.toHaveProperty("content-type");
});
