import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { AudioTranscriptionDialog } from "./audio-transcription-dialog";
import { muscriptorProvider } from "@/lib/muscriptor";
import type {
  AudioTranscriptionProvider,
  TranscriptionOptions,
  TranscriptionResult,
} from "@/lib/audio-transcription/provider";
import { renderWithProviders } from "@/test/render";
import { expectNoA11yViolations } from "@/test/axe";

vi.mock("@/lib/audio-transcription/duration", () => ({
  audioDurationMs: vi.fn().mockResolvedValue(272_000),
}));

const MIDI: TranscriptionResult = {
  midi: new Uint8Array([77, 84, 104, 100]),
  notes: [{ pitch: 60, start: 0, end: 1, instrument: "acoustic_piano", velocity: 90 }],
  durationSeconds: 3,
};
const recording = () => new File(["audio"], "my-song.wav", { type: "audio/wav" });
function setup(overrides: Partial<AudioTranscriptionProvider> = {}) {
  const provider = {
    ...muscriptorProvider,
    configured: vi.fn().mockResolvedValue(true),
    transcribe: vi.fn().mockResolvedValue(MIDI),
    ...overrides,
  };
  const onImport = vi.fn().mockResolvedValue(undefined);
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  const props = { provider, onOpenChange, onImport, onSave };
  const ui = renderWithProviders(<AudioTranscriptionDialog open {...props} />);
  /** Renders the dialog again with other props, as App does. */
  const update = (changes: Partial<ComponentProps<typeof AudioTranscriptionDialog>>) =>
    ui.rerender(<AudioTranscriptionDialog open {...props} {...changes} />);
  return { ...ui, provider, onImport, onSave, onOpenChange, update };
}
/** Transcribe is enabled once the dialog knows this build can transcribe. */
async function transcribe(user: ReturnType<typeof setup>["user"]) {
  const button = screen.getByRole("button", { name: "Transcribe" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}
describe("audio transcription", () => {
  it("disables transcription when the build has no transcription server", async () => {
    const { user } = setup({ configured: vi.fn().mockResolvedValue(false) });
    expect(
      await screen.findByText("Audio transcription is not available in this build."),
    ).toBeInTheDocument();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    expect(screen.getByRole("button", { name: "Transcribe" })).toBeDisabled();
  });
  it("says where the recording goes and shows its duration before upload", async () => {
    const { user, provider } = setup();
    expect(screen.getByText(/uploaded to Smart Beat's transcription server/)).toBeInTheDocument();
    expect(screen.getByText(/by Kyutai and Mirelo/)).toBeInTheDocument();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    expect(await screen.findByText(/· 4:32/)).toBeInTheDocument();
    expect(provider.transcribe).not.toHaveBeenCalled();
  });
  it("validates dropped formats, size and empty files before upload", async () => {
    const { provider } = setup();
    const drop = (file: File) =>
      fireEvent.drop(screen.getByRole("button", { name: "Choose recording…" }), {
        dataTransfer: { files: [file] },
      });
    drop(new File(["bad"], "song.m4a"));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose MP3, WAV, FLAC, OGG audio.");
    drop(new File([], "empty.wav"));
    expect(screen.getByRole("alert")).toHaveTextContent("empty");
    const large = recording();
    Object.defineProperty(large, "size", { value: 101 * 1024 * 1024 });
    drop(large);
    expect(screen.getByRole("alert")).toHaveTextContent("100 MiB");
    drop(recording());
    expect(screen.getByText("my-song.wav")).toBeInTheDocument();
    expect(provider.transcribe).not.toHaveBeenCalled();
  });
  it("searches upstream aliases, selects multiple instruments, previews, saves and imports", async () => {
    const { user, provider, onImport, onSave, onOpenChange } = setup();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await user.type(screen.getByLabelText("Search instruments"), "rhodes");
    await user.click(screen.getByRole("button", { name: "electric piano" }));
    await user.clear(screen.getByLabelText("Search instruments"));
    await user.type(screen.getByLabelText("Search instruments"), "kit");
    await user.click(screen.getByRole("button", { name: "drums" }));
    await transcribe(user);
    expect(provider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my-song.wav" }),
      ["electric_piano", "drums"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      await screen.findByRole("img", { name: "Transcribed notes by instrument" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations();
    await user.click(screen.getByRole("button", { name: "Save MIDI As…" }));
    expect(onSave).toHaveBeenCalledWith(MIDI.midi, "my-song.mid");
    await user.click(screen.getByRole("button", { name: "Import MIDI into Smart Beat" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(MIDI.midi, "my-song.mid"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
  it("shows the server's progress, and Cancel stops the transcription", async () => {
    let options: TranscriptionOptions | undefined;
    const { user } = setup({
      transcribe: vi.fn((_file, _instruments, opts: TranscriptionOptions) => {
        options = opts;
        opts.onProgress({ phase: "processing", message: "Transcribing recording…", percent: 40 });
        return new Promise<TranscriptionResult>(() => {});
      }),
    });
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await transcribe(user);
    expect(await screen.findByText("Transcribing recording…")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel transcription" }));
    expect(options!.signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Transcribe" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("stops the transcription when another dialog replaces this one", async () => {
    let options: TranscriptionOptions | undefined;
    const { user, update } = setup({
      transcribe: vi.fn((_file, _instruments, opts: TranscriptionOptions) => {
        options = opts;
        return new Promise<TranscriptionResult>(() => {});
      }),
    });
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await transcribe(user);
    await screen.findByRole("button", { name: "Cancel transcription" });
    // The native menu opens About: App hides this dialog without a Close.
    update({ open: false });
    expect(options!.signal.aborted).toBe(true);
    update({ open: true });
    expect(await screen.findByRole("button", { name: "Transcribe" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel transcription" })).not.toBeInTheDocument();
  });
  it("ignores a dropped recording that finishes reading after Transcribe", async () => {
    let finishRead!: (file: File) => void;
    const { user, update } = setup({
      readFile: vi.fn(() => new Promise<File>((resolve) => (finishRead = resolve))),
      transcribe: vi.fn(() => new Promise<TranscriptionResult>(() => {})),
    });
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    update({ droppedRecording: { path: "/music/other.wav", nonce: 1 } });
    await transcribe(user);
    await act(async () => finishRead(new File(["audio"], "other.wav", { type: "audio/wav" })));
    expect(screen.getByText("my-song.wav")).toBeInTheDocument();
    expect(screen.queryByText("other.wav")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel transcription" })).toBeInTheDocument();
  });
  it("keeps the recording selected when the transcription fails, so it can be tried again", async () => {
    const { user, provider } = setup({
      transcribe: vi
        .fn()
        .mockRejectedValueOnce({ kind: "audio", message: "The transcription server is busy." })
        .mockResolvedValue(MIDI),
    });
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await transcribe(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("busy");
    expect(screen.getByText("my-song.wav")).toBeInTheDocument();
    await transcribe(user);
    await screen.findByRole("heading", { name: "Generated MIDI preview" });
    expect(provider.transcribe).toHaveBeenCalledTimes(2);
  });
  it("keeps the result when import fails", async () => {
    const { user, onImport, onOpenChange } = setup();
    onImport.mockRejectedValue(new Error("Invalid MIDI"));
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await transcribe(user);
    await user.click(await screen.findByRole("button", { name: "Import MIDI into Smart Beat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid MIDI");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save MIDI As…" })).toBeEnabled();
  });
  it("starts over with New transcription", async () => {
    const { user } = setup();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await transcribe(user);
    await user.click(await screen.findByRole("button", { name: "New transcription" }));
    expect(screen.queryByText("my-song.wav")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose recording…" })).toBeEnabled();
  });
});
