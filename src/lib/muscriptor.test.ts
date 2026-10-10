import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { audioDurationMs } from "@/lib/audio-transcription/duration";
import { muscriptorProvider, withAbort } from "./muscriptor";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/audio-transcription/duration", () => ({ audioDurationMs: vi.fn() }));

type Handler = (event: { payload: unknown }) => void;
let progressHandler: Handler | undefined;
const unlisten = vi.fn();
beforeEach(() => {
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    progressHandler = handler as Handler;
    return unlisten;
  });
  vi.mocked(audioDurationMs).mockResolvedValue(3000);
});
afterEach(() => {
  vi.mocked(invoke).mockReset();
  unlisten.mockReset();
});
const song = () => new File(["mp3"], "Song.MP3");
const options = (signal = new AbortController().signal) => ({ signal, onProgress: vi.fn() });

it("sends the recording as the raw body with its details in headers and returns the MIDI bytes", async () => {
  vi.mocked(invoke).mockResolvedValue({ midiBase64: "TVRoZA==", notes: [], durationSeconds: 3 });
  const result = await muscriptorProvider.transcribe(song(), ["electric_bass", "drums"], options());
  expect(result.midi).toEqual(new Uint8Array([77, 84, 104, 100]));
  const [command, body, init] = vi.mocked(invoke).mock.calls[0]!;
  expect(command).toBe("transcribe_audio");
  expect(body).toEqual(new Uint8Array([109, 112, 51]));
  expect(init?.headers).toEqual(
    expect.objectContaining({
      "file-type": "mp3",
      "duration-ms": "3000",
      instruments: "electric_bass,drums",
      "operation-id": expect.any(String),
    }),
  );
  expect(unlisten).toHaveBeenCalledOnce();
});
it("reports only its own operation's progress", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const opts = options();
  const pending = muscriptorProvider.transcribe(song(), [], opts);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  const headers = vi.mocked(invoke).mock.calls[0]![2]!.headers as Record<string, string>;
  const progress = { phase: "processing", message: "Transcribing recording…", percent: 50 };
  progressHandler!({ payload: { operationId: "someone-else", ...progress } });
  progressHandler!({ payload: { operationId: headers["operation-id"], ...progress } });
  expect(opts.onProgress.mock.calls).toEqual([[progress]]);
  finish({ midiBase64: "TVRoZA==", notes: [], durationSeconds: 3 });
  await pending;
});
it("cancels on the server when the signal aborts", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "transcribe_audio" ? new Promise(() => {}) : undefined,
  );
  const controller = new AbortController();
  const pending = muscriptorProvider.transcribe(song(), [], options(controller.signal));
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("transcribe_audio", expect.anything(), expect.anything()),
  );
  const headers = vi.mocked(invoke).mock.calls[0]![2]!.headers as Record<string, string>;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).toHaveBeenCalledWith("cancel_transcription", {
    operationId: headers["operation-id"],
  });
});
it("refuses recordings over 15 minutes before uploading", async () => {
  vi.mocked(audioDurationMs).mockResolvedValue(15 * 60_000 + 1);
  await expect(muscriptorProvider.transcribe(song(), [], options())).rejects.toThrow(
    "up to 15 minutes",
  );
  expect(invoke).not.toHaveBeenCalled();
});
it("allows local cancellation while an IPC call is still pending", async () => {
  const controller = new AbortController();
  const pending = withAbort(new Promise<number>(() => {}), controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
