import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LaneEditorDock, type LaneEditorActions } from "@/components/audio-lanes/lane-editor-dock";
import { StudioView } from "@/components/audio-lanes/studio-view";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { FIT_MARGIN_PX } from "@/lib/audio-lanes/zoom";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import { PlayheadStore } from "@/lib/score/playhead";
import type { AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

/** Eight bars of 4/4 at 120 bpm: the score ends at 16 s. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const SOURCE = {
  id: "a".repeat(64),
  name: "take.wav",
  ext: "wav",
  path: "/music/take.wav",
  embedded: true,
};
/** The width the scrollers get (jsdom lays nothing out). */
const VIEW_WIDTH = 832;

function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a")],
      },
      {
        ...newLane("Drums", "lane-b"),
        clips: [newClip(SOURCE.id, "take.wav", 8000, 2000, "clip-b")],
      },
      newLane("Bass", "lane-c"),
    ],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;

/** Runs the real lanes hook over a mix and hands the controller to `children`. */
function Lanes({ children }: { children: (lanes: AudioLanesController) => ReactNode }) {
  const [mix, setMix] = useState<MixerSettings>({
    version: 3,
    master: 1,
    tracks: [],
    audio: song(),
  });
  const lanes = useAudioLanes({
    mix,
    changeMix: (action) => setMix((m) => mixerReducer(m, action)),
    loadSource: () => new Promise(() => {}),
    songPath: null,
    grid,
  });
  useEffect(() => {
    latest.lanes = lanes;
  });
  return <>{children(lanes)}</>;
}

const actions = (): LaneEditorActions => ({
  syncFromScoreTempo: vi.fn(() => []),
  tempoFromSync: vi.fn(),
  syncFromBeats: vi.fn(),
  replaceFile: vi.fn(),
  extract: vi.fn(),
  addBar: vi.fn(),
  effects: vi.fn(),
  openStudio: vi.fn(),
  close: vi.fn(),
});

/** The lane editor on Vocals, with the position line at bar 3 (4 s). */
function renderDock(selectedBars: { start: number; end: number } | null = null) {
  const playhead = new PlayheadStore();
  playhead.set(2);
  return renderWithProviders(
    <Lanes>
      {(lanes) => (
        <LaneEditorDock
          lanes={lanes}
          lane={lanes.audio.lanes[0]!}
          index={0}
          grid={grid}
          scoreBpmAt={() => 120}
          playhead={playhead}
          playing={false}
          selectedBars={selectedBars}
          onSelectBars={vi.fn()}
          onSeekBar={vi.fn()}
          actions={actions()}
        />
      )}
    </Lanes>,
  );
}

function renderStudio() {
  return renderWithProviders(
    <Lanes>
      {(lanes) => (
        <StudioView
          lanes={lanes}
          grid={grid}
          markers={[]}
          playing={false}
          position="1"
          actions={{
            playPause: vi.fn(),
            record: vi.fn(),
            effects: vi.fn(),
            renderLanes: vi.fn(),
            renderRange: vi.fn(),
            close: vi.fn(),
          }}
        />
      )}
    </Lanes>,
  );
}

/** The position line's left edge, px (bar 3 is at 4 s: 4 × the zoom). */
const lineLeft = () => Number.parseFloat(screen.getByTestId("position-line").style.left);
const zoomOf = () => lineLeft() / 4;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(VIEW_WIDTH);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Lane editor zoom", () => {
  it("zooms in and out with the buttons and the = and - keys", async () => {
    const { user } = renderDock();
    const editor = screen.getByRole("region", { name: "Lane editor: Vocals" });
    const zoom = within(editor).getByRole("group", { name: "Zoom" });
    expect(zoomOf()).toBe(60);
    await user.click(within(zoom).getByRole("button", { name: "Zoom in" }));
    expect(zoomOf()).toBe(90);
    await user.click(within(zoom).getByRole("button", { name: "Zoom out" }));
    expect(zoomOf()).toBe(60);
    fireEvent.keyDown(editor, { key: "=" });
    expect(zoomOf()).toBe(90);
    fireEvent.keyDown(editor, { key: "-" });
    fireEvent.keyDown(editor, { key: "-" });
    expect(zoomOf()).toBe(40);
    // A key typed into the filter list belongs to it.
    fireEvent.keyDown(within(editor).getByRole("combobox", { name: "Filter" }), { key: "=" });
    expect(zoomOf()).toBe(40);
    await expectNoA11yViolations();
  });

  it("fits the whole song, to the score's end, into the scroller", async () => {
    const { user } = renderDock();
    await user.click(screen.getByRole("button", { name: "Zoom to fit the song" }));
    // The score ends at 16 s, after the last clip (10 s).
    expect(zoomOf()).toBeCloseTo((VIEW_WIDTH - 2 * FIT_MARGIN_PX) / 16, 6);
  });

  it("zooms to the selected clips, else to the selected bars", async () => {
    const { user, unmount } = renderDock();
    const toSelection = () => screen.getByRole("button", { name: "Zoom to the selection" });
    expect(toSelection()).toBeDisabled();
    act(() => lanesNow().select(["clip-a"]));
    // The disabled button sits in a tooltip wrapper: once enabled it is a new element.
    await user.click(toSelection());
    // clip-a runs 2 s to 6 s.
    expect(zoomOf()).toBeCloseTo((VIEW_WIDTH - 2 * FIT_MARGIN_PX) / 4, 6);
    unmount();

    renderDock({ start: 0, end: 3 });
    fireEvent.keyDown(screen.getByRole("region", { name: "Lane editor: Vocals" }), { key: "z" });
    // Bars 1 to 4 run 0 s to 8 s.
    expect(zoomOf()).toBeCloseTo((VIEW_WIDTH - 2 * FIT_MARGIN_PX) / 8, 6);
  });

  it("zooms with ⌘-wheel, and a plain wheel scrolls sideways", () => {
    renderDock();
    const editor = screen.getByRole("region", { name: "Lane editor: Vocals" });
    const scroller = screen.getByTestId("position-line").closest(".overflow-auto")!;
    expect(editor).toContainElement(scroller as HTMLElement);
    fireEvent.wheel(scroller, { deltaY: -100, metaKey: true, clientX: 240 });
    expect(zoomOf()).toBeGreaterThan(60);
    const zoomed = zoomOf();
    fireEvent.wheel(scroller, { deltaY: 100, ctrlKey: true, clientX: 240 });
    expect(zoomOf()).toBeCloseTo(60, 6);
    expect(zoomed).toBeGreaterThan(zoomOf());
    // A plain turn scrolls; the zoom stays.
    const scrolled = fireEvent.wheel(scroller, { deltaY: 40 });
    expect(scrolled).toBe(false);
    expect(zoomOf()).toBeCloseTo(60, 6);
  });
});

describe("Studio zoom and lane height", () => {
  it("has the zoom commands, and resizes a lane from its lower edge", async () => {
    const { user } = renderStudio();
    const studio = screen.getByRole("dialog", { name: "Studio" });
    const vocals = screen.getByTestId("studio-lane-lane-a");
    const drums = screen.getByTestId("studio-lane-lane-b");
    expect(within(studio).getByRole("group", { name: "Zoom" })).toBeInTheDocument();
    const slider = within(studio).getByRole("slider", { name: "Zoom" });
    expect(slider).toHaveValue("40");
    await user.click(within(studio).getByRole("button", { name: "Zoom in" }));
    expect(slider).toHaveValue("60");
    fireEvent.keyDown(studio, { key: "-" });
    expect(slider).toHaveValue("40");

    const handle = within(studio).getByRole("button", { name: /^Resize Vocals \(80 px\)/ });
    expect(vocals).toHaveStyle({ height: "80px" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(vocals).toHaveStyle({ height: "90px" });
    expect(lanesNow().audio.lanes[0]!.height).toBe(90);
    // A drag down by 40 px, as one undo step.
    fireEvent.pointerDown(handle, { clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientY: 120 });
    fireEvent.pointerMove(window, { clientY: 140 });
    fireEvent.pointerUp(window);
    expect(vocals).toHaveStyle({ height: "130px" });
    act(() => void lanesNow().undo());
    expect(vocals).toHaveStyle({ height: "90px" });
    // The range stops at 40 px.
    fireEvent.pointerDown(handle, { clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientY: -500 });
    fireEvent.pointerUp(window);
    expect(vocals).toHaveStyle({ height: "40px" });
    expect(drums).toHaveStyle({ height: "80px" });
    // A short lane keeps only its name, mute and solo in the header.
    expect(within(vocals).queryByRole("button", { name: /^FX/ })).not.toBeInTheDocument();
    expect(within(vocals).getByRole("button", { name: "Mute Vocals" })).toBeInTheDocument();
    // A double-click resets it.
    fireEvent.doubleClick(handle);
    expect(vocals).toHaveStyle({ height: "80px" });
    expect(lanesNow().audio.lanes[0]!.height).toBeUndefined();
    await expectNoA11yViolations();
  });

  it("resizes the selected lanes with Alt and every lane with Shift", () => {
    renderStudio();
    const heights = () => lanesNow().audio.lanes.map((l) => l.height);
    act(() => lanesNow().select(["clip-b"]));
    const bass = screen.getByRole("button", { name: /^Resize Bass/ });
    fireEvent.keyDown(bass, { key: "ArrowDown", altKey: true });
    expect(heights()).toEqual([undefined, 90, 90]);
    fireEvent.keyDown(bass, { key: "ArrowUp", shiftKey: true });
    // Every lane takes the dragged lane's new height.
    expect(heights()).toEqual([80, 80, 80]);
    fireEvent.doubleClick(bass, { shiftKey: true });
    expect(heights()).toEqual([undefined, undefined, undefined]);
  });
});
