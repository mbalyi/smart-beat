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
import { getAiState, resetAiStore, seedAiState, statusWith } from "@/lib/ai/ai-store";
import { track } from "@/lib/telemetry";
import { expectNoA11yViolations } from "@/test/axe";

vi.mock("@/lib/audio-transcription/duration", () => ({
  audioDurationMs: vi.fn().mockResolvedValue(272_000),
}));

vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
vi.mock("@/lib/audio-transcription/preview", () => ({
  NotePreview: class {
    play() {
      return Promise.resolve();
    }
    stop() {}
    position() {
      return 0;
    }
    setMix() {}
    setStereo() {}
  },
  decodeOriginal: vi.fn().mockResolvedValue(null),
}));
beforeEach(() => {
  // MuScriptor is on this computer and the terms are accepted.
  seedAiState({ ready: true, status: statusWith(["medium"]) });
});
afterEach(() => resetAiStore());

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
  it("disables transcription outside the desktop app", async () => {
    const { user } = setup({ configured: vi.fn().mockResolvedValue(false) });
    expect(
      await screen.findByText("Audio transcription is available in the desktop app."),
    ).toBeInTheDocument();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    expect(screen.getByRole("button", { name: "Transcribe" })).toBeDisabled();
  });
  it("says that the recording stays on this computer and shows its duration", async () => {
    const { user, provider } = setup();
    expect(screen.getByText(/transcribed on this computer/)).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Automatic detection" }));
    await user.type(screen.getByLabelText("Search instruments"), "rhodes");
    await user.click(screen.getByRole("checkbox", { name: "electric piano" }));
    await user.clear(screen.getByLabelText("Search instruments"));
    await user.type(screen.getByLabelText("Search instruments"), "kit");
    await user.click(screen.getByRole("checkbox", { name: "drums" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Remove electric piano" })).toBeInTheDocument();
    await transcribe(user);
    expect(provider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my-song.wav" }),
      ["electric_piano", "drums"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      await screen.findByRole("img", { name: "Transcribed notes by instrument" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Import from Audio" })).toBeInTheDocument();
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
    expect(screen.getByText(/my-song\.wav/)).toBeInTheDocument();
    expect(screen.queryByText(/other\.wav/)).not.toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "Preview generated MIDI" });
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
  it("goes back to the upload step with the recording and instruments kept", async () => {
    const { user, provider } = setup();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await user.click(screen.getByRole("button", { name: "Automatic detection" }));
    await user.click(screen.getByRole("checkbox", { name: "drums" }));
    await user.keyboard("{Escape}");
    await transcribe(user);
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(screen.getByText("my-song.wav")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove drums" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save MIDI As…" })).not.toBeInTheDocument();
    await transcribe(user);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Replace recording…" })).toBeEnabled();
    expect(provider.transcribe).toHaveBeenCalledTimes(2);
  });
  it("removes the chosen recording with its X", async () => {
    const { user } = setup();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await user.click(screen.getByRole("button", { name: "Remove recording" }));
    expect(screen.queryByText("my-song.wav")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose recording…" })).toBeEnabled();
  });

  it("offers the download first while MuScriptor is not on this computer", async () => {
    seedAiState({ ready: true, status: statusWith([], false) });
    const { user, onOpenChange } = setup();
    expect(await screen.findByTestId("audio-needs-model")).toBeInTheDocument();
    // Nothing to drop or transcribe yet.
    expect(screen.queryByLabelText("Choose an audio recording")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transcribe" })).not.toBeInTheDocument();
    expect(screen.getByText("Model sizes and performance")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Import from Audio" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download MuScriptor" }));
    // The dialog steps aside and the installer opens, remembering where to return to.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(getAiState().installer).toEqual({ open: true, returnTo: "audio" });
  });
  it("counts every start with the state of the rights confirmation", async () => {
    const { user } = setup();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await transcribe(user);
    await screen.findByText("Import MIDI into Smart Beat");
    expect(track).toHaveBeenCalledWith("ai_transcribe_file", "rights_confirmed");
  });
  it("keeps the transcribe button off when the terms are not on file", async () => {
    seedAiState({ ready: true, status: { ...statusWith(["medium"]), termsAccepted: false } });
    setup();
    expect(await screen.findByTestId("audio-needs-model")).toBeInTheDocument();
  });

  it("says so where the engine is not built in, and does not offer the download", async () => {
    seedAiState({
      ready: false,
      unsupported: true,
      status: { ...statusWith([]), supported: false },
    });
    setup();
    expect(await screen.findByTestId("audio-unsupported")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-needs-model")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download MuScriptor" })).not.toBeInTheDocument();
  });
  it("numbers the download as step 0 while MuScriptor is not on this computer", async () => {
    seedAiState({ ready: true, status: statusWith([], false) });
    setup();
    await screen.findByTestId("audio-needs-model");
    const steps = screen
      .getAllByRole("listitem")
      .filter((item) => item.dataset.slot === "stepper-item");
    expect(steps.map((item) => item.textContent)).toEqual([
      "0Download MuScriptor (current step)",
      "1Upload",
      "2Transcribe",
      "3Preview",
    ]);
  });
  it("starts the stepper at Upload once the model is installed", async () => {
    setup();
    const steps = (await screen.findAllByRole("listitem")).filter(
      (item) => item.dataset.slot === "stepper-item",
    );
    expect(steps).toHaveLength(3);
    expect(screen.queryByText("Download MuScriptor")).not.toBeInTheDocument();
  });
  it("picks the model after the instruments and opens the installer, which returns here", async () => {
    seedAiState({ ready: true, status: statusWith(["small", "medium"]) });
    const { user, onOpenChange } = setup();
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /^Small/ }));
    expect(getAiState().size).toBe("small");
    await user.click(screen.getByRole("button", { name: "Download or manage models…" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(getAiState().installer).toEqual({ open: true, returnTo: "audio" });
  });
});
