import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorTimeline } from "@/components/audio-lanes/editor-timeline";
import { LaneRow } from "@/components/audio-lanes/lane-row";
import { StudioView } from "@/components/audio-lanes/studio-view";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

/** Eight bars of 4/4 at 120 bpm (a bar is 2 s). */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const SOURCE = { id: "a".repeat(64), name: "take.wav", ext: "wav", embedded: true };
/** How tall each lane row is on the fake screen. */
const ROW_PX = 50;

/** Vocals: clip-a at 2 s (4 s long) and clip-b at 10 s; Drums: clip-d at 0 s and clip-c at 4 s. */
function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [
          newClip(SOURCE.id, "verse.wav", 2000, 4000, "clip-a"),
          newClip(SOURCE.id, "chorus.wav", 10_000, 2000, "clip-b"),
        ],
      },
      {
        ...newLane("Drums", "lane-b"),
        clips: [
          newClip(SOURCE.id, "intro.wav", 0, 1000, "clip-d"),
          newClip(SOURCE.id, "fill.wav", 4000, 2000, "clip-c"),
        ],
      },
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
    loader: () => null,
    canLoad: false,
    epoch: 0,
    songPath: null,
    grid,
    ensureEngine: () => true,
  });
  useEffect(() => {
    latest.lanes = lanes;
  });
  return <>{children(lanes)}</>;
}

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  }) as DOMRect;

/**
 * jsdom lays nothing out: lane rows are stacked ROW_PX apart in document order from x 0, and a
 * clip sits where its inline `left` and `width` put it on its row.
 */
function fakeLayout() {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const lane = this.closest<HTMLElement>("[data-lane-id]");
    if (!lane) return rect(0, 0, 0, 0);
    const row = [...document.querySelectorAll("[data-lane-id]")].indexOf(lane);
    if (lane === this) return rect(0, row * ROW_PX, 2000, ROW_PX);
    return rect(
      parseFloat(this.style.left) || 0,
      row * ROW_PX + 4,
      parseFloat(this.style.width) || 0,
      ROW_PX - 8,
    );
  });
}

const laneArea = (laneId: string) =>
  document.querySelector<HTMLElement>(`[data-lane-id="${laneId}"]`)!;

/** A drag with the main button from one point to another, on the element pressed. */
function drag(
  el: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  keys: { shiftKey?: boolean; metaKey?: boolean } = {},
) {
  const at = (p: { x: number; y: number }) => ({
    button: 0,
    pointerId: 1,
    clientX: p.x,
    clientY: p.y,
    ...keys,
  });
  fireEvent.pointerDown(el, at(from));
  fireEvent.pointerMove(el, at({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }));
  fireEvent.pointerMove(el, at(to));
  fireEvent.pointerUp(el, at(to));
}

const status = () => screen.getByRole("status");
const clipButton = (name: RegExp) => screen.getByRole("button", { name });

let layout: ReturnType<typeof fakeLayout>;
beforeEach(() => {
  layout = fakeLayout();
});
afterEach(() => {
  layout.mockRestore();
});

describe("Selecting clips in the track list", () => {
  // 20 px a bar: clip-a 20–60, clip-b 100–120 on Vocals; clip-d 0–24, clip-c 40–60 on Drums.
  const renderList = () =>
    renderWithProviders(
      <Lanes>
        {(lanes) => (
          <ul>
            {lanes.audio.lanes.map((lane, index) => (
              <LaneRow
                key={lane.id}
                lanes={lanes}
                lane={lane}
                index={index}
                barWidth={20}
                barCount={8}
                grid={grid}
                playing={false}
                onEffects={vi.fn()}
                onOpenEditor={vi.fn()}
              />
            ))}
          </ul>
        )}
      </Lanes>,
    );

  it("selects one clip with a click and toggles clips with ⌘-click", async () => {
    const { user } = renderList();
    await user.click(clipButton(/verse\.wav/));
    expect(lanesNow().selection).toEqual(["clip-a"]);
    await user.keyboard("{Meta>}");
    await user.click(clipButton(/fill\.wav/));
    await user.click(clipButton(/chorus\.wav/));
    await user.click(clipButton(/verse\.wav/));
    await user.keyboard("{/Meta}");
    expect(lanesNow().selection).toEqual(["clip-c", "clip-b"]);
    expect(clipButton(/fill\.wav/)).toHaveAttribute("aria-pressed", "true");
    expect(clipButton(/verse\.wav/)).toHaveAttribute("aria-pressed", "false");
    expect(status()).toHaveTextContent("2 clips selected");
    await user.click(clipButton(/intro\.wav/));
    expect(lanesNow().selection).toEqual(["clip-d"]);
    await expectNoA11yViolations();
  });

  it("selects the clips between the last clicked one and a Shift-click, across lanes", async () => {
    const { user } = renderList();
    await user.click(clipButton(/verse\.wav/));
    await user.keyboard("{Shift>}");
    await user.click(clipButton(/fill\.wav/));
    await user.keyboard("{/Shift}");
    // From 2 s on Vocals to 4 s on Drums: not intro (0 s) nor chorus (10 s).
    expect([...lanesNow().selection].sort()).toEqual(["clip-a", "clip-c"]);
    expect(status()).toHaveTextContent("2 clips selected");
  });

  it("frames clips across lanes with a drag on empty space, leaving the cursor", () => {
    renderList();
    drag(laneArea("lane-a"), { x: 30, y: 10 }, { x: 70, y: 70 });
    expect(lanesNow().selection).toEqual(["clip-a", "clip-c"]);
    expect(lanesNow().editCursorMs).toBe(0);
    expect(screen.queryByTestId("marquee")).not.toBeInTheDocument();
    expect(status()).toHaveTextContent("2 clips selected");
  });

  it("draws the rectangle while dragging and adds to the selection with Shift", () => {
    renderList();
    act(() => lanesNow().select(["clip-b"]));
    const area = laneArea("lane-b");
    fireEvent.pointerDown(area, { button: 0, clientX: 10, clientY: 60, shiftKey: true });
    fireEvent.pointerMove(area, { clientX: 30, clientY: 90, shiftKey: true });
    expect(screen.getByTestId("marquee")).toHaveStyle({
      left: "10px",
      top: "60px",
      width: "20px",
      height: "30px",
    });
    expect(lanesNow().selection).toEqual(["clip-b", "clip-d"]);
    fireEvent.pointerUp(area, { clientX: 30, clientY: 90 });
    expect(screen.queryByTestId("marquee")).not.toBeInTheDocument();
  });

  it("moves the edit cursor and clears the selection on a click without a drag", () => {
    renderList();
    act(() => lanesNow().select(["clip-a", "clip-b"]));
    // A few pixels of jitter is still a click: 100 px is bar 5, 10 s.
    drag(laneArea("lane-b"), { x: 100, y: 70 }, { x: 102, y: 71 });
    expect(lanesNow().editCursorMs).toBe(10_000);
    expect(lanesNow().selection).toEqual([]);
    expect(status()).toHaveTextContent("No clips selected");
  });

  it("selects every clip on the lane with ⌘A and clears the selection with Escape", async () => {
    const { user } = renderList();
    await user.click(clipButton(/verse\.wav/));
    await user.keyboard("{Meta>}a{/Meta}");
    expect(lanesNow().selection).toEqual(["clip-a", "clip-b"]);
    expect(status()).toHaveTextContent("2 clips selected");
    await user.keyboard("{Escape}");
    expect(lanesNow().selection).toEqual([]);
  });
});

describe("Selecting clips in the lane editor", () => {
  // 20 px a second: clip-a 40–120 and clip-b 200–240.
  const renderEditor = () =>
    renderWithProviders(
      <Lanes>
        {(lanes) => (
          <EditorTimeline
            lanes={lanes}
            lane={lanes.audio.lanes[0]!}
            color="#ffd21a"
            grid={grid}
            pxPerSecond={20}
            scoreBpmAt={() => 120}
            selectedBars={null}
            onSelectBars={vi.fn()}
            onSeekBar={vi.fn()}
          />
        )}
      </Lanes>,
    );

  it("frames the lane's clips with a plain drag", () => {
    renderEditor();
    drag(laneArea("lane-a"), { x: 100, y: 10 }, { x: 210, y: 30 });
    expect(lanesNow().selection).toEqual(["clip-a", "clip-b"]);
    expect(status()).toHaveTextContent("2 clips selected");
  });

  it("keeps ⌘-drag on empty space for sliding the audio", () => {
    renderEditor();
    drag(laneArea("lane-a"), { x: 100, y: 10 }, { x: 210, y: 30 }, { metaKey: true });
    expect(lanesNow().selection).toEqual([]);
    expect(lanesNow().canUndo).toBe(true);
  });

  it("selects a range on the lane with Shift-click", async () => {
    const { user } = renderEditor();
    await user.click(clipButton(/chorus\.wav/));
    await user.keyboard("{Shift>}");
    await user.click(clipButton(/verse\.wav/));
    await user.keyboard("{/Shift}");
    expect(lanesNow().selection).toEqual(["clip-a", "clip-b"]);
  });
});

describe("Selecting clips in the studio", () => {
  const close = vi.fn();
  // 40 px a second: clip-a 80–240, clip-b 400–480; clip-d 0–40, clip-c 160–240.
  const renderStudio = () =>
    renderWithProviders(
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
              close,
            }}
          />
        )}
      </Lanes>,
    );

  it("frames clips across lanes, and Escape clears them before it closes", async () => {
    close.mockClear();
    const { user } = renderStudio();
    drag(laneArea("lane-a"), { x: 200, y: 20 }, { x: 420, y: 80 });
    expect(lanesNow().selection).toEqual(["clip-a", "clip-b", "clip-c"]);
    const studio = screen.getByRole("dialog", { name: "Studio" });
    expect(within(studio).getByRole("status")).toHaveTextContent("3 clips selected");
    await user.click(within(studio).getByRole("button", { name: /fill\.wav/ }));
    expect(lanesNow().selection).toEqual(["clip-c"]);
    await user.keyboard("{Escape}");
    expect(lanesNow().selection).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalled();
  });
});
