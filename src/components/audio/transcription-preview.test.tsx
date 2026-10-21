import { screen, waitFor, within } from "@testing-library/react";
import { decodeOriginal } from "@/lib/audio-transcription/preview";
import { TranscriptionPreview } from "./transcription-preview";
import type { TranscriptionNote } from "@/lib/audio-transcription/provider";
import { renderWithProviders } from "@/test/render";

const played = vi.hoisted(() => [] as TranscriptionNote[][]);
vi.mock("@/lib/audio-transcription/preview", () => ({
  NotePreview: class {
    play(notes: TranscriptionNote[]) {
      played.push(notes);
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

const decoded = vi.mocked(decodeOriginal);
const notes: TranscriptionNote[] = [
  { pitch: 40, start: 0, end: 1, instrument: "electric_bass", velocity: 90 },
  { pitch: 64, start: 0, end: 1, instrument: "clean_electric_guitar", velocity: 90 },
  { pitch: 67, start: 1, end: 2, instrument: "clean_electric_guitar", velocity: 90 },
];

function setup(props: { file?: File; onEdit?: () => void } = {}) {
  played.length = 0;
  return renderWithProviders(
    <TranscriptionPreview
      active
      result={{ midi: new Uint8Array(), notes, durationSeconds: 2 }}
      {...props}
    />,
  );
}

describe("TranscriptionPreview", () => {
  it("lists generated tracks and hides one from the piano roll", async () => {
    const { user } = setup();
    const roll = screen.getByRole("img", { name: "Transcribed notes by instrument" });
    expect(within(roll).getByText("electric bass")).toBeInTheDocument();
    expect(roll.querySelectorAll("rect.fill-primary")).toHaveLength(3);

    await user.click(screen.getByRole("checkbox", { name: "Show electric bass" }));
    expect(within(roll).queryByText("electric bass")).not.toBeInTheDocument();
    expect(roll.querySelectorAll("rect.fill-primary")).toHaveLength(2);
  });

  it("plays only unmuted tracks, or the soloed one", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Mute electric bass" }));
    await user.click(screen.getByRole("button", { name: "Play MIDI preview" }));
    expect(played.at(-1)!.map((n) => n.pitch)).toEqual([64, 67]);

    await user.click(screen.getByRole("checkbox", { name: "Mute electric bass" }));
    // Soloing while it plays restarts the audio with the new selection.
    await user.click(screen.getByRole("button", { name: "Solo electric bass" }));
    expect(played.at(-1)!.map((n) => n.pitch)).toEqual([40]);
  });

  it("names the preview and offers Edit only when it can go back", async () => {
    const onEdit = vi.fn();
    const { user } = setup({ onEdit });
    expect(screen.getByRole("heading", { name: "Preview generated MIDI" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalled();
  });

  it("says when the original cannot be decoded, and leaves the mix off", async () => {
    setup({ file: new File(["x"], "song.wav") });
    expect(await screen.findByText(/could not be decoded; only the MIDI will play/)).toBeVisible();
    expect(screen.getByRole("slider", { name: "Original and MIDI mix" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Stereo/ })).toBeDisabled();
  });

  it("enables the mix once the original is decoded", async () => {
    decoded.mockResolvedValueOnce({} as AudioBuffer);
    setup({ file: new File(["x"], "song.wav") });
    await waitFor(() =>
      expect(screen.getByRole("slider", { name: "Original and MIDI mix" })).toBeEnabled(),
    );
    expect(screen.getByRole("checkbox", { name: /Stereo/ })).toBeEnabled();
  });
});
