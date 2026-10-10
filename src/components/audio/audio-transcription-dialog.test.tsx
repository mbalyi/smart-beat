import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AudioTranscriptionDialog } from "./audio-transcription-dialog";
import { mireloProvider } from "@/lib/mirelo";
import {
  TranscriptionError,
  type AudioTranscriptionProvider,
  type TranscriptionResult,
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
const QUOTE = { assetId: "one", durationMs: 3000, credits: 8, estimatedMs: 1000 };
const recording = () => new File(["audio"], "my-song.wav", { type: "audio/wav" });
function setup(overrides: Partial<AudioTranscriptionProvider> = {}) {
  const provider = {
    ...mireloProvider,
    configured: vi.fn().mockResolvedValue(true),
    pending: vi.fn().mockResolvedValue(null),
    saveKey: vi.fn().mockResolvedValue(undefined),
    forgetKey: vi.fn().mockResolvedValue(undefined),
    quote: vi.fn().mockResolvedValue(QUOTE),
    transcribe: vi.fn().mockResolvedValue(MIDI),
    resume: vi.fn().mockResolvedValue(MIDI),
    discardPending: vi.fn().mockResolvedValue(undefined),
    openPage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const onImport = vi.fn().mockResolvedValue(undefined);
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  const ui = renderWithProviders(
    <AudioTranscriptionDialog
      open
      provider={provider}
      onOpenChange={onOpenChange}
      onImport={onImport}
      onSave={onSave}
    />,
  );
  return { ...ui, provider, onImport, onSave, onOpenChange };
}
async function upload(user: ReturnType<typeof setup>["user"]) {
  await screen.findByText("Personal Mirelo account connected");
  await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
  await user.click(screen.getByRole("button", { name: "Upload and check cost" }));
  await screen.findByRole("button", { name: "Confirm and transcribe" });
}
describe("audio transcription", () => {
  it("requires personal credentials and preserves native auth/quota error messages", async () => {
    const { user, provider } = setup({
      configured: vi.fn().mockResolvedValue(false),
      saveKey: vi.fn().mockRejectedValue({ kind: "audio", message: "Unlock your keychain." }),
    });
    await user.type(screen.getByLabelText("Personal Mirelo API key"), "secret");
    await user.click(screen.getByRole("button", { name: "Connect Mirelo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unlock your keychain.");
    expect(provider.saveKey).toHaveBeenCalledWith("secret");
    expect(screen.getByRole("button", { name: "Upload and check cost" })).toBeDisabled();
  });
  it("shows the recording's duration before upload and opens provider pages in the browser", async () => {
    const { user, provider } = setup();
    await screen.findByText("Personal Mirelo account connected");
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    expect(await screen.findByText(/· 4:32/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Provider privacy policy" }));
    await user.click(screen.getByRole("button", { name: "Provider terms" }));
    await user.click(screen.getByRole("button", { name: "Mirelo Studio" }));
    expect(vi.mocked(provider.openPage).mock.calls).toEqual([["privacy"], ["terms"], ["account"]]);
    expect(provider.quote).not.toHaveBeenCalled();
  });
  it("validates dropped formats, size and empty files before upload", async () => {
    const { provider } = setup();
    const drop = (file: File) =>
      fireEvent.drop(screen.getByRole("button", { name: "Choose recording…" }), {
        dataTransfer: { files: [file] },
      });
    drop(new File(["bad"], "bad.txt"));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose mp3");
    drop(new File([], "empty.wav"));
    expect(screen.getByRole("alert")).toHaveTextContent("empty");
    const large = recording();
    Object.defineProperty(large, "size", { value: 101 * 1024 * 1024 });
    drop(large);
    expect(screen.getByRole("alert")).toHaveTextContent("100 MiB");
    drop(recording());
    expect(screen.getByText("my-song.wav")).toBeInTheDocument();
    expect(provider.quote).not.toHaveBeenCalled();
  });
  it("searches upstream aliases, selects multiple valid instrument ids, previews, saves and imports", async () => {
    const { user, provider, onImport, onSave, onOpenChange } = setup();
    await screen.findByText("Personal Mirelo account connected");
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await user.type(screen.getByLabelText("Search instruments"), "rhodes");
    await user.click(screen.getByRole("button", { name: "electric piano" }));
    await user.clear(screen.getByLabelText("Search instruments"));
    await user.type(screen.getByLabelText("Search instruments"), "kit");
    await user.click(screen.getByRole("button", { name: "drums" }));
    await user.click(screen.getByRole("button", { name: "Upload and check cost" }));
    await screen.findByRole("button", { name: "Confirm and transcribe" });
    expect(provider.transcribe).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm and transcribe" }));
    expect(provider.transcribe).toHaveBeenCalledWith(
      QUOTE,
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
  it("shows quote errors without submitting a paid job", async () => {
    const { user, provider } = setup({
      quote: vi.fn().mockRejectedValue({ kind: "audio", message: "Add 10 credits in Studio." }),
    });
    await screen.findByText("Personal Mirelo account connected");
    await user.upload(screen.getByLabelText("Choose an audio recording"), recording());
    await user.click(screen.getByRole("button", { name: "Upload and check cost" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add 10 credits");
    expect(provider.transcribe).not.toHaveBeenCalled();
  });
  it("keeps the result when import fails", async () => {
    const { user, onImport, onOpenChange } = setup();
    onImport.mockRejectedValue(new Error("Invalid MIDI"));
    await upload(user);
    await user.click(screen.getByRole("button", { name: "Confirm and transcribe" }));
    await user.click(await screen.findByRole("button", { name: "Import MIDI into Smart Beat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid MIDI");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save MIDI As…" })).toBeEnabled();
  });
  it("recovers a saved job and never creates it again", async () => {
    const { user, provider } = setup({ pending: vi.fn().mockResolvedValue(QUOTE) });
    await user.click(await screen.findByRole("button", { name: "Resume saved job" }));
    expect(
      await screen.findByRole("heading", { name: "Generated MIDI preview" }),
    ).toBeInTheDocument();
    expect(provider.resume).toHaveBeenCalledOnce();
    expect(provider.transcribe).not.toHaveBeenCalled();
  });
  it("allows stop and resume while protecting uncertain paid attempts", async () => {
    const { user, provider } = setup({
      transcribe: vi.fn().mockRejectedValue(new TranscriptionError("Connection interrupted", true)),
    });
    await upload(user);
    await user.click(screen.getByRole("button", { name: "Confirm and transcribe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
    expect(
      screen.queryByRole("button", { name: "Confirm and transcribe" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss saved attempt" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Resume saved job" }));
    await screen.findByRole("heading", { name: "Generated MIDI preview" });
    expect(provider.transcribe).toHaveBeenCalledOnce();
  });
});
