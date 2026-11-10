import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { EditorTimeline } from "@/components/audio-lanes/editor-timeline";
import { StudioView } from "@/components/audio-lanes/studio-view";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, clipEndMs, newClip, newLane } from "@/lib/audio-lanes/model";
import type { TimeRange } from "@/lib/audio-lanes/range-edits";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

/** Eight bars of 4/4 at 120 bpm. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const SOURCE = { id: "a".repeat(64), name: "take.wav", ext: "wav", embedded: true };
/** The studio's default zoom: pixels per second. */
const PPS = 40;
const xAt = (ms: number) => (ms / 1000) * PPS;

/** Vocals with one clip from 0 to 8 s, drums with one from 4 to 6 s. */
function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      { ...newLane("Vocals", "lane-a"), clips: [newClip(SOURCE.id, "take.wav", 0, 8000, "a")] },
      { ...newLane("Drums", "lane-b"), clips: [newClip(SOURCE.id, "hit.wav", 4000, 2000, "b")] },
    ],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;

/** Runs the real lanes hook over a mix and hands the controller to `children`. */
function Lanes({
  children,
  onTimeRangeChange,
}: {
  children: (lanes: AudioLanesController) => ReactNode;
  onTimeRangeChange?: (range: TimeRange | null) => void;
}) {
  const [mix, setMix] = useState<MixerSettings>({
    version: 3,
    master: 1,
    tracks: [],
    audio: song(),
  });
  const lanes = useAudioLanes({
    mix,
    changeMix: (action) => setMix((m) => mixerReducer(m, action)),
    loader: () => null,
    canLoad: false,
    epoch: 0,
    songPath: null,
    grid,
    ensureEngine: () => true,
    onTimeRangeChange,
  });
  useEffect(() => {
    latest.lanes = lanes;
  });
  return <>{children(lanes)}</>;
}

function renderStudio(onTimeRangeChange = vi.fn()) {
  const view = renderWithProviders(
    <Lanes onTimeRangeChange={onTimeRangeChange}>
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
  return { ...view, onTimeRangeChange, ruler: screen.getByTestId("studio-ruler") };
}

/** Drags across the studio ruler from one time to another. */
function dragRuler(ruler: HTMLElement, fromMs: number, toMs: number, shiftKey = false) {
  fireEvent.pointerDown(ruler, { clientX: xAt(fromMs), pointerId: 1, shiftKey });
  fireEvent.pointerMove(ruler, { clientX: xAt(toMs), pointerId: 1, shiftKey });
  fireEvent.pointerUp(ruler, { clientX: xAt(toMs), pointerId: 1, shiftKey });
}

/** Each clip of a lane as [start, end] in ms, rounded. */
const spans = (laneId: string) =>
  lanesNow()
    .audio.lanes.find((l) => l.id === laneId)!
    .clips.map((c) => [Math.round(c.startMs), Math.round(clipEndMs(c))]);

describe("time selection in the studio", () => {
  it("drags a snapped selection on the ruler, labels it and hands it on as the loop", async () => {
    const { ruler, onTimeRangeChange } = renderStudio();
    // 1.1 s snaps to the beat at 1 s; 2.9 s to the one at 3 s.
    dragRuler(ruler, 1100, 2900);
    expect(lanesNow().timeRange).toEqual({ startMs: 1000, endMs: 3000 });
    expect(onTimeRangeChange).toHaveBeenLastCalledWith({ startMs: 1000, endMs: 3000 });
    expect(screen.getByTestId("time-range-label")).toHaveTextContent(
      "Selection 0:01.00 – 0:03.00 (2.00 s) on 2 lanes",
    );
    expect(screen.getByTestId("time-range-band")).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("extends the selection with Shift, and a click on the ruler clears it", () => {
    const { ruler, onTimeRangeChange } = renderStudio();
    dragRuler(ruler, 1000, 2000);
    fireEvent.pointerDown(ruler, { clientX: xAt(4000), pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(ruler, { clientX: xAt(4000), pointerId: 1, shiftKey: true });
    expect(lanesNow().timeRange).toEqual({ startMs: 1000, endMs: 4000 });

    fireEvent.pointerDown(ruler, { clientX: xAt(5000), pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: xAt(5000), pointerId: 1 });
    expect(lanesNow().timeRange).toBeNull();
    expect(onTimeRangeChange).toHaveBeenLastCalledWith(null);
    expect(lanesNow().editCursorMs).toBe(5000);
    expect(screen.queryByTestId("time-range-band")).not.toBeInTheDocument();
  });

  it("clears the selection with Escape before the studio closes", async () => {
    const { ruler, user } = renderStudio();
    dragRuler(ruler, 1000, 3000);
    await user.keyboard("{Escape}");
    expect(lanesNow().timeRange).toBeNull();
    expect(screen.getByRole("dialog", { name: "Studio" })).toBeInTheDocument();
  });

  it("splits at the edges with Shift+S, as one undo step", async () => {
    const { ruler, user } = renderStudio();
    dragRuler(ruler, 1000, 3000);
    screen.getByRole("button", { name: "Split at the edges" }).focus();
    await user.keyboard("{Shift>}S{/Shift}");
    expect(spans("lane-a")).toEqual([
      [0, 1000],
      [1000, 3000],
      [3000, 8000],
    ]);
    act(() => void lanesNow().undo());
    expect(spans("lane-a")).toEqual([[0, 8000]]);
  });

  it("trims to the selection on the lanes in range only", async () => {
    const { ruler, user } = renderStudio();
    await user.click(screen.getByRole("button", { name: "Range: Drums in range edits" }));
    dragRuler(ruler, 1000, 3000);
    await user.click(screen.getByRole("button", { name: "Trim to selection" }));
    expect(spans("lane-a")).toEqual([[1000, 3000]]);
    expect(spans("lane-b")).toEqual([[4000, 6000]]);
  });

  it("removes the selection and closes the gap on every lane", async () => {
    const { ruler, user, onTimeRangeChange } = renderStudio();
    dragRuler(ruler, 1000, 3000);
    await user.click(screen.getByRole("button", { name: "Remove and close gap" }));
    expect(spans("lane-a")).toEqual([
      [0, 1000],
      [1000, 6000],
    ]);
    expect(spans("lane-b")).toEqual([[2000, 4000]]);
    expect(lanesNow().timeRange).toBeNull();
    expect(onTimeRangeChange).toHaveBeenLastCalledWith(null);
  });

  it("inserts empty space at the selection and keeps locked clips in place", async () => {
    const { ruler, user } = renderStudio();
    act(() =>
      lanesNow().apply((a) => ({
        ...a,
        lanes: a.lanes.map((l) =>
          l.id === "lane-b" ? { ...l, clips: l.clips.map((c) => ({ ...c, locked: true })) } : l,
        ),
      })),
    );
    dragRuler(ruler, 1000, 3000);
    await user.click(screen.getByRole("button", { name: "Insert space" }));
    expect(spans("lane-a")).toEqual([
      [0, 1000],
      [3000, 10000],
    ]);
    expect(spans("lane-b")).toEqual([[4000, 6000]]);
    expect(lanesNow().timeRange).toEqual({ startMs: 1000, endMs: 3000 });
  });

  it("offers the selection's edits in the lane menu while there is one", async () => {
    const { ruler } = renderStudio();
    const lane = screen.getByTestId("studio-lane-lane-b").querySelector("[data-lane-id]")!;
    fireEvent.contextMenu(lane, { clientX: xAt(7000) });
    let menu = await screen.findByRole("menu", { name: "Lane actions: Drums" });
    expect(within(menu).queryByText("Trim to the selection")).not.toBeInTheDocument();
    fireEvent.keyDown(menu, { key: "Escape" });

    dragRuler(ruler, 1000, 3000);
    fireEvent.contextMenu(lane, { clientX: xAt(7000) });
    menu = await screen.findByRole("menu", { name: "Lane actions: Drums" });
    expect(within(menu).getByText("Selection 0:01.00 – 0:03.00 (2.00 s)")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Insert empty space/ }));
    expect(spans("lane-b")).toEqual([[6000, 8000]]);
  });
});

describe("time selection in the lane editor", () => {
  it("shows the selection as a band over the lane", () => {
    renderWithProviders(
      <Lanes>
        {(lanes) => (
          <EditorTimeline
            lanes={lanes}
            lane={lanes.audio.lanes[0]!}
            color="#888"
            grid={grid}
            pxPerSecond={PPS}
            scoreBpmAt={() => 120}
            selectedBars={null}
            onSelectBars={vi.fn()}
            onSeekBar={vi.fn()}
          />
        )}
      </Lanes>,
    );
    expect(screen.queryByTestId("editor-time-range")).not.toBeInTheDocument();
    act(() => lanesNow().setTimeRange({ startMs: 1000, endMs: 3000 }));
    expect(screen.getByTestId("editor-time-range")).toHaveStyle({
      left: `${xAt(1000)}px`,
      width: `${xAt(2000)}px`,
    });
  });
});
