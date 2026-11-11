import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScoreLanesBand } from "@/components/audio-lanes/score-lanes-band";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import type { BarSpan } from "@/lib/audio-lanes/bar-bounds";
import { laneDropTarget } from "@/lib/audio-lanes/drop-target";
import { EMPTY_AUDIO, clipEndMs, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { PlayheadStore } from "@/lib/score/playhead";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioLane, AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

/** Eight bars of 4/4 at 120 bpm: a bar is 2 s, a beat 500 ms. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
/**
 * Where the score draws the bars: after 40 px for the clef, a narrow bar (100 px), a wide one
 * (300), a narrow one, a wide one, then four of 200. Time is not proportional to pixels.
 */
const WIDTHS = [100, 300, 100, 300, 200, 200, 200, 200];
const spans: BarSpan[] = WIDTHS.map((width, i) => ({
  x: 40 + WIDTHS.slice(0, i).reduce((a, b) => a + b, 0),
  width,
}));
const SOURCE = {
  id: "a".repeat(64),
  name: "take.wav",
  ext: "wav",
  path: "/music/take.wav",
  embedded: true,
};
const ROW_PX = 80;

/** Vocals: clip-a at bar 1, clip-b at bar 3. Drums: clip-c from bar 2 to the start of bar 4. */
function song(extra: AudioLane[] = []): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [
          newClip(SOURCE.id, "verse.wav", 0, 2000, "clip-a"),
          newClip(SOURCE.id, "chorus.wav", 4000, 2000, "clip-b"),
        ],
      },
      {
        ...newLane("Drums", "lane-b"),
        clips: [newClip(SOURCE.id, "fill.wav", 2000, 4000, "clip-c")],
      },
      ...extra,
    ],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;
const clipsOf = (laneId: string) => lanesNow().audio.lanes.find((l) => l.id === laneId)!.clips;
const clipById = (id: string) =>
  lanesNow()
    .audio.lanes.flatMap((l) => l.clips)
    .find((c) => c.id === id)!;

function Lanes({
  audio,
  children,
}: {
  audio: AudioLanesSettings;
  children: (lanes: AudioLanesController) => ReactNode;
}) {
  const [mix, setMix] = useState<MixerSettings>({ version: 3, master: 1, tracks: [], audio });
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

function renderBand(audio = song(), scroller: HTMLElement | null = null) {
  const playhead = new PlayheadStore();
  const onOpenEditor = vi.fn();
  const view = renderWithProviders(
    <Lanes audio={audio}>
      {(lanes) => (
        <ScoreLanesBand
          lanes={lanes}
          grid={grid}
          spans={spans}
          playhead={playhead}
          scroller={scroller}
          onOpenEditor={onOpenEditor}
        />
      )}
    </Lanes>,
  );
  return { ...view, playhead, onOpenEditor };
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

const laneArea = (laneId: string) =>
  document.querySelector<HTMLElement>(`[data-lane-id="${laneId}"]`)!;
const clipButton = (name: RegExp) => screen.getByRole("button", { name });
const leftOf = (el: HTMLElement) => parseFloat(el.style.left);
const widthOf = (el: HTMLElement) => parseFloat(el.style.width);

let layout: ReturnType<typeof fakeLayout>;
beforeEach(() => {
  layout = fakeLayout();
});
afterEach(() => {
  layout.mockRestore();
});

describe("the lanes band under the tabs", () => {
  it("shows a row per lane, each clip on the bars it plays in", () => {
    renderBand();
    const band = screen.getByTestId("score-lanes-band");
    expect(band).toHaveAccessibleName("Audio lanes under the score");
    expect(within(band).getByRole("group", { name: /Audio lane Vocals/ })).toBeInTheDocument();
    expect(within(band).getByRole("group", { name: /Audio lane Drums/ })).toBeInTheDocument();
    // The first lane is above the second, and each row is 80 px (the lane's default height).
    const rows = screen.getAllByTestId(/^band-lane-lane-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "band-lane-lane-a",
      "band-lane-lane-b",
    ]);
    expect(rows[0]!.style.height).toBe("80px");
    // clip-a is bar 1 (40–140); clip-c runs from bar 2 (140) to the end of bar 3 (540).
    const a = clipButton(/verse\.wav on Vocals/);
    expect(leftOf(a)).toBe(40);
    expect(widthOf(a)).toBe(100);
    const c = clipButton(/fill\.wav on Drums/);
    expect(leftOf(c)).toBe(140);
    expect(widthOf(c)).toBe(400);
    // The name, mute and solo of each lane at its left.
    expect(screen.getByTestId("band-lane-name-lane-a")).toHaveTextContent("Vocals");
    // Bar lines run through the band, and the position and edit lines too.
    expect(screen.getByTestId("band-bar-1").style.left).toBe("140px");
    expect(screen.getByTestId("band-edit-cursor")).toBeInTheDocument();
    expect(screen.getByTestId("band-position-line")).toBeInTheDocument();
  });

  it("follows the lane's height, and shows mute and solo", () => {
    renderBand(
      song().lanes.length
        ? {
            ...song(),
            lanes: song().lanes.map((l, i) =>
              i === 0 ? { ...l, height: 120, mute: true } : { ...l, height: 20, solo: true },
            ),
          }
        : song(),
    );
    expect(screen.getByTestId("band-lane-lane-a").style.height).toBe("120px");
    // Never shorter than 40 px.
    expect(screen.getByTestId("band-lane-lane-b").style.height).toBe("40px");
    expect(screen.getByTestId("band-lane-name-lane-a")).toHaveTextContent("Vocals");
    expect(
      within(screen.getByTestId("band-lane-name-lane-a")).getByLabelText("Muted"),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("band-lane-name-lane-b")).getByLabelText("Soloed"),
    ).toBeVisible();
  });

  it("puts the position line where playback is, through the bars", () => {
    const { playhead } = renderBand();
    act(() => playhead.set(1.5));
    // Half way through the wide bar 2 (140–440).
    expect(screen.getByTestId("band-position-line").style.left).toBe("290px");
    act(() => playhead.set(0.5));
    expect(screen.getByTestId("band-position-line").style.left).toBe("90px");
  });

  it("hides the lanes of a closed folder, and shows the folder as a thin row", async () => {
    const folder = { ...newLane("Stems", "folder"), folder: true, collapsed: true };
    const inside = { ...newLane("Inside", "lane-in"), parent: "folder" };
    const { user } = renderBand(song([folder, inside]));
    expect(screen.getByTestId("band-folder-folder")).toBeInTheDocument();
    expect(screen.queryByTestId("band-lane-lane-in")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Open the folder Stems/ }));
    expect(screen.getByTestId("band-lane-lane-in")).toBeInTheDocument();
  });

  it("draws only the clips near what is on screen, and the selected one wherever it is", async () => {
    const far = newClip(SOURCE.id, "late.wav", 12_000, 2000, "clip-far");
    const audio = song();
    audio.lanes[0] = { ...audio.lanes[0]!, clips: [...audio.lanes[0]!.clips, far] };
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientWidth", { value: 300, configurable: true });
    renderBand(audio, scroller);
    // Bar 7 starts at 1240 px, past the 300 px on screen and the margin around it.
    expect(screen.queryByRole("button", { name: /late\.wav/ })).not.toBeInTheDocument();
    expect(clipButton(/verse\.wav/)).toBeInTheDocument();
    // Scrolled there it appears.
    scroller.scrollLeft = 1100;
    // The band moves left as the scroller scrolls (jsdom lays nothing out).
    screen.getByTestId("score-lanes-band").getBoundingClientRect = () => rect(-1100, 0, 1720, 160);
    fireEvent.scroll(scroller);
    await waitFor(() => expect(clipButton(/late\.wav/)).toBeInTheDocument());
  });
});

describe("editing in the band, through the bars' own widths", () => {
  it("drops a dragged clip where its pixels are in time: a wide bar holds more pixels per second", () => {
    renderBand();
    // clip-a (bar 1, 40–140) dragged 160 px right to x 200: 60 px into the 300 px bar 2, a fifth
    // of it, 2.4 s, on the beat at 2.5 s. At 50 px a second it would have landed at 3.2 s.
    drag(clipButton(/verse\.wav/), { x: 80, y: 40 }, { x: 240, y: 40 });
    expect(clipById("clip-a").startMs).toBe(2500);
  });

  it("drops a clip dragged across a narrow bar and into a wide one on its beat", () => {
    renderBand();
    // clip-b (bar 3 at 440) moved left by 100 px: 200 px into the wide bar 2, two thirds: 3.33 s.
    drag(clipButton(/chorus\.wav/), { x: 480, y: 40 }, { x: 380, y: 40 });
    expect(clipById("clip-b").startMs).toBe(3500);
  });

  it("trims an edge at the time under the pointer", () => {
    renderBand();
    // clip-b ends at 6 s (x 540). Its end edge dragged 150 px right: half the wide bar 4: 7 s.
    drag(clipButton(/chorus\.wav/), { x: 538, y: 40 }, { x: 688, y: 40 });
    expect(clipEndMs(clipById("clip-b"))).toBe(7000);
    expect(clipById("clip-b").startMs).toBe(4000);
  });

  it("shows the fade and volume handles on the selected clip only, and a fade follows the bars", () => {
    renderBand();
    expect(screen.queryByTestId("clip-handles-clip-c")).not.toBeInTheDocument();
    act(() => lanesNow().select(["clip-c"]));
    expect(screen.getByTestId("clip-handles-clip-c")).toBeInTheDocument();
    expect(screen.queryByTestId("clip-handles-clip-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("clip-gain-clip-c")).toBeInTheDocument();
    // The fade-in handle (at the start, x 140) dragged 150 px right is half way into bar 2's
    // 300 px: the fade ends at 3 s, a second after the clip starts.
    const handle = screen.getByTestId("clip-fade-in-clip-c");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 140, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 290, clientY: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 290, clientY: 10 });
    expect(clipById("clip-c").fadeIn.ms).toBe(1000);
  });

  it("frames the clips of several lanes with a rectangle", () => {
    renderBand();
    // From empty space on the first lane down across the second: clip-b (440–540) and clip-c.
    drag(laneArea("lane-a"), { x: 450, y: 5 }, { x: 520, y: 100 });
    expect([...lanesNow().selection].sort()).toEqual(["clip-b", "clip-c"]);
    expect(screen.queryByTestId("marquee")).not.toBeInTheDocument();
    expect(screen.getByTestId("clip-selection-status")).toHaveTextContent("2 clips selected");
  });

  it("puts the edit cursor where empty space is clicked, on a beat", () => {
    renderBand();
    // x 290 is half way into the wide bar 2: 3 s.
    fireEvent.pointerDown(laneArea("lane-a"), {
      button: 0,
      pointerId: 1,
      clientX: 290,
      clientY: 5,
    });
    fireEvent.pointerUp(laneArea("lane-a"), { button: 0, pointerId: 1, clientX: 290, clientY: 5 });
    expect(lanesNow().editCursorMs).toBe(3000);
    expect(screen.getByTestId("band-edit-cursor").style.left).toBe("290px");
  });

  it("splits a clip from the right-click menu at the edit cursor", async () => {
    const { user } = renderBand();
    act(() => lanesNow().setEditCursorMs(3000));
    fireEvent.contextMenu(clipButton(/fill\.wav on Drums/));
    await user.click(await screen.findByRole("menuitem", { name: /Split at the position line/ }));
    const pieces = clipsOf("lane-b");
    expect(pieces.map((c) => [c.startMs, clipEndMs(c)])).toEqual([
      [2000, 3000],
      [3000, 6000],
    ]);
  });

  it("works from the keyboard: S splits, Delete removes", async () => {
    renderBand();
    act(() => lanesNow().setEditCursorMs(3000));
    const clip = clipButton(/fill\.wav on Drums/);
    clip.focus();
    fireEvent.keyDown(clip, { key: "s" });
    await waitFor(() => expect(clipsOf("lane-b")).toHaveLength(2));
    const [piece] = screen.getAllByRole("button", { name: /fill\.wav on Drums/ });
    fireEvent.keyDown(piece!, { key: "Delete" });
    await waitFor(() => expect(clipsOf("lane-b")).toHaveLength(1));
  });

  it("opens the lane editor from a double-click on a clip", () => {
    const { onOpenEditor } = renderBand();
    fireEvent.doubleClick(clipButton(/verse\.wav/));
    expect(onOpenEditor).toHaveBeenCalledWith("lane-a");
  });

  it("tells a file dropped on a lane where it lands, by the bars", () => {
    renderBand();
    const lane = laneArea("lane-a");
    const target = laneDropTarget(
      { x: 290, y: 10 },
      () => 0,
      () => ({ closest: () => lane }),
    );
    expect(target).toMatchObject({ laneId: "lane-a", atMs: 3000 });
  });

  it("has no accessibility violations", async () => {
    renderBand();
    act(() => lanesNow().select(["clip-c"]));
    await expectNoA11yViolations();
  });
});
