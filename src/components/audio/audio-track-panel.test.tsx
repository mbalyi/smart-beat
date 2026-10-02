import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";

import { AudioTrackPanel } from "@/components/audio/audio-track-panel";
import { formatMs } from "@/lib/audio/audio-track";
import { FLAT_EQ } from "@/lib/score/mixer";
import type { AudioTrackSettings, BackingInfo } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const INFO: BackingInfo = {
  name: "take.mp3",
  durationMs: 8000,
  sampleRate: 44_100,
  channels: 2,
  peaks: Array.from({ length: 800 }, (_, i) => (i % 50) / 50),
  peaksPerSecond: 100,
};

const AUDIO: AudioTrackSettings = {
  name: "take.mp3",
  path: "/music/take.mp3",
  embedded: false,
  enabled: true,
  volume: 0.8,
  pan: 0,
  mute: false,
  solo: false,
  eq: FLAT_EQ,
  semitones: 0,
  cents: 0,
  filter: "off",
  sync: [{ bar: 1, ms: 2500 }],
};

/** Four bars of 2 s. */
const BAR_TIMES = [0, 2000, 4000, 6000, 8000];

function setup(info: BackingInfo | null = INFO, canEmbed = true) {
  const handlers = {
    onChange: vi.fn(),
    onRemove: vi.fn(),
    onLocate: vi.fn(),
    onImportTempo: vi.fn(),
    onClose: vi.fn(),
  };
  let latest = AUDIO;
  function Harness() {
    const [audio, setAudio] = useState(AUDIO);
    const [zoom, setZoom] = useState(40);
    return (
      <AudioTrackPanel
        audio={audio}
        info={info}
        barTimes={BAR_TIMES}
        barWidth={zoom}
        onBarWidthChange={setZoom}
        {...handlers}
        onChange={(next) => {
          latest = next;
          handlers.onChange(next);
          setAudio(next);
        }}
        canEmbed={canEmbed}
      />
    );
  }
  const utils = renderWithProviders(<Harness />);
  const panel = screen.getByRole("region", { name: "Audio track" });
  return { ...utils, panel, ...handlers, audio: () => latest };
}

describe("AudioTrackPanel", () => {
  it("shows the recording on the bars with its sync points", async () => {
    const { panel } = setup();
    expect(within(panel).getByText(/take\.mp3 · 0:08\.00/)).toBeInTheDocument();
    const marker = within(panel).getByRole("slider", { name: "Sync point at bar 2" });
    expect(marker).toHaveAttribute("aria-valuetext", `${formatMs(2500)} in the recording`);
    expect(marker.style.left).toBe("40px");
    await expectNoA11yViolations();
  });

  it("adds a sync point at the nearest bar line with a double-click", () => {
    const { panel, audio } = setup();
    const waveform = within(panel).getByTestId("audio-waveform");
    waveform.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 64 }) as DOMRect;
    fireEvent.doubleClick(waveform, { clientX: 118 });
    // Bar 4 (index 3) is 2 s after the bar 2 sync point.
    expect(audio().sync).toEqual([
      { bar: 1, ms: 2500 },
      { bar: 3, ms: 6500 },
    ]);
    // Not twice at the same bar.
    fireEvent.doubleClick(waveform, { clientX: 121 });
    expect(audio().sync).toHaveLength(2);
  });

  it("moves sync points with the keyboard and by dragging, and removes them", async () => {
    const { user, panel, audio } = setup();
    const marker = within(panel).getByRole("slider", { name: "Sync point at bar 2" });
    marker.focus();
    await user.keyboard("{ArrowRight}{Shift>}{ArrowLeft}{/Shift}");
    expect(audio().sync[0]!.ms).toBe(2500 + 10 - 100);
    fireEvent.pointerDown(marker, { clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(marker, { clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(marker, { pointerId: 1 });
    // 2 s per 40 px bar: 10 px is half a second later.
    expect(audio().sync[0]!.ms).toBe(2410 + 500);
    within(panel).getByRole("slider", { name: "Sync point at bar 2" }).focus();
    await user.keyboard("{Delete}");
    expect(audio().sync).toEqual([]);
  });

  it("transposes, filters, embeds and zooms", async () => {
    const { user, panel, audio, onImportTempo, onRemove, onClose } = setup();
    const semitones = within(panel).getByLabelText("Semitones");
    fireEvent.change(semitones, { target: { value: "-3" } });
    expect(audio().semitones).toBe(-3);
    fireEvent.change(within(panel).getByLabelText("Cents"), { target: { value: "25" } });
    expect(audio().cents).toBe(25);
    await user.click(within(panel).getByRole("combobox", { name: "Filter" }));
    await user.click(screen.getByRole("option", { name: "Bass only" }));
    expect(audio().filter).toBe("bassIsolate");
    await user.click(
      within(panel).getByRole("switch", { name: "Embed the recording in the song file" }),
    );
    expect(audio().embedded).toBe(true);
    await user.click(within(panel).getByRole("switch", { name: "Audio track on" }));
    expect(audio().enabled).toBe(false);
    const zoom = within(panel).getByRole("slider", { name: "Waveform zoom" });
    zoom.focus();
    await user.keyboard("{ArrowRight}");
    expect(within(panel).getByRole("slider", { name: "Sync point at bar 2" }).style.left).toBe(
      "44px",
    );
    await user.click(within(panel).getByRole("button", { name: "Sync points from tempo changes" }));
    expect(onImportTempo).toHaveBeenCalled();
    await user.click(within(panel).getByRole("button", { name: "Clear sync points" }));
    expect(audio().sync).toEqual([]);
    await user.click(within(panel).getByRole("button", { name: "Remove the audio track" }));
    expect(onRemove).toHaveBeenCalled();
    await user.click(within(panel).getByRole("button", { name: "Close the audio track editor" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers to find a recording that is not loaded", async () => {
    const { user, panel, onLocate } = setup(null, false);
    expect(within(panel).getByText(/is not loaded/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Find the file…" }));
    expect(onLocate).toHaveBeenCalled();
    expect(
      within(panel).getByRole("switch", { name: "Embed the recording in the song file" }),
    ).toBeDisabled();
  });
});
