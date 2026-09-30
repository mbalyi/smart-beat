import { screen } from "@testing-library/react";

import { LyricsStrip } from "@/components/score/lyrics-strip";
import { setLyrics, syllablesAround } from "@/lib/score/lyrics";
import { refinish } from "@/lib/score/model";
import { expectNoA11yViolations } from "@/test/axe";
import { texScore } from "@/test/playback";
import { renderWithProviders } from "@/test/render";

function song() {
  const score = texScore(String.raw`\track "Voice" \staff {score} :4 C4 D4 E4 F4 | G4 A4 B4 C5`);
  const track = score.tracks[0]!;
  setLyrics(track, [
    { startBar: 0, text: "Hel-lo sun-ny day to you and me" },
    { startBar: 1, text: "sec-ond line" },
  ]);
  refinish(score);
  const beats = track.staves[0]!.bars.flatMap((bar) => bar.voices[0]!.beats);
  return { track, beats };
}

describe("LyricsStrip", () => {
  it("shows the lines around the beat and highlights its syllable", async () => {
    const { track, beats } = song();
    const current = beats[2]!; // "sun-"
    renderWithProviders(<LyricsStrip lines={syllablesAround(track, current)} current={current} />);
    const strip = screen.getByRole("region", { name: "Lyrics" });
    // Eight notes: the last syllable ("me") has no note to go on.
    expect(strip).toHaveTextContent("Hel-lo sun-ny day to you and");
    expect(strip).not.toHaveTextContent("me");
    expect(strip).toHaveTextContent("sec-ond line");
    const now = strip.querySelector("[aria-current='true']");
    expect(now).toHaveTextContent("sun");
    expect(strip.querySelectorAll("[aria-current]")).toHaveLength(1);
    // Not announced while it changes: that would drown out the music.
    expect(strip).not.toHaveAttribute("aria-live");
    await expectNoA11yViolations();
  });

  it("says so where there are no lyrics", () => {
    renderWithProviders(<LyricsStrip lines={[]} current={null} />);
    expect(screen.getByRole("region", { name: "Lyrics" })).toHaveTextContent("No lyrics here");
  });
});
