import { screen, within } from "@testing-library/react";
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
  },
}));

const notes: TranscriptionNote[] = [
  { pitch: 40, start: 0, end: 1, instrument: "electric_bass", velocity: 90 },
  { pitch: 64, start: 0, end: 1, instrument: "clean_electric_guitar", velocity: 90 },
  { pitch: 67, start: 1, end: 2, instrument: "clean_electric_guitar", velocity: 90 },
];

function setup() {
  played.length = 0;
  return renderWithProviders(
    <TranscriptionPreview active result={{ midi: new Uint8Array(), notes, durationSeconds: 2 }} />,
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
    await user.click(screen.getByRole("button", { name: "Solo electric bass" }));
    await user.click(screen.getByRole("button", { name: "Play MIDI preview" }));
    expect(played.at(-1)!.map((n) => n.pitch)).toEqual([40]);
  });
});
