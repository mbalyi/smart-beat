import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ClipView } from "@/components/audio-lanes/clip-view";
import { LaneRow } from "@/components/audio-lanes/lane-row";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioClip, AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

/** Eight bars of 4/4 at 120 bpm. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const SOURCE = { id: "a".repeat(64), name: "take.wav", ext: "wav", embedded: true };

/** A song with one 4 s clip at 2 s on "Vocals". */
function song(patch: Partial<AudioClip> = {}): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [{ ...newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a"), ...patch }],
      },
    ],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;
const clipNow = () => lanesNow().audio.lanes[0]!.clips[0]!;

/** Runs the real lanes hook over a mix and hands the controller to `children`. */
function Lanes({
  children,
  audio,
}: {
  children: (lanes: AudioLanesController) => ReactNode;
  audio: AudioLanesSettings;
}) {
  const [mix, setMix] = useState<MixerSettings>({ version: 3, master: 1, tracks: [], audio });
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

/** One clip on a plain lane at 100 px a second (`pxPerMs` to change it). */
function renderClip(patch: Partial<AudioClip> = {}, pxPerMs = 0.1) {
  return renderWithProviders(
    <Lanes audio={song(patch)}>
      {(lanes) => (
        <div className="relative h-20" data-lane-id="lane-a">
          {lanes.audio.lanes[0]!.clips.map((clip) => (
            <ClipView
              key={clip.id}
              clip={clip}
              laneName="Vocals"
              color="#ffd21a"
              info={undefined}
              missing={false}
              selected={false}
              toX={(ms) => ms * pxPerMs}
              toMs={(x) => x / pxPerMs}
              snap={(ms) => ms}
              onSelect={vi.fn()}
              onDrop={vi.fn()}
              onKey={vi.fn()}
              onOpen={vi.fn()}
              edits={lanes}
            />
          ))}
        </div>
      )}
    </Lanes>,
  );
}

const fadeIn = () => screen.getByRole("slider", { name: /^Fade in of take\.wav/ });
const fadeOut = () => screen.getByRole("slider", { name: /^Fade out of take\.wav/ });
const volume = () => screen.getByRole("slider", { name: /^Volume of take\.wav/ });

/** Presses on `el` at (x, y), moves through `moves` and lets go. */
function drag(
  el: Element,
  from: { x?: number; y?: number },
  moves: { x?: number; y?: number; shift?: boolean }[],
) {
  fireEvent.pointerDown(el, {
    button: 0,
    pointerId: 1,
    clientX: from.x ?? 0,
    clientY: from.y ?? 0,
  });
  for (const m of moves)
    fireEvent.pointerMove(el, {
      pointerId: 1,
      clientX: m.x ?? from.x ?? 0,
      clientY: m.y ?? from.y ?? 0,
      shiftKey: m.shift ?? false,
    });
  fireEvent.pointerUp(el, { pointerId: 1 });
}

describe("ClipHandles", () => {
  it("shows labelled fade and volume sliders on the clip", async () => {
    renderClip({ fadeIn: { ms: 200, shape: "linear" } });
    expect(fadeIn()).toHaveAccessibleName("Fade in of take.wav, 200 ms");
    expect(fadeIn()).toHaveAttribute("aria-valuenow", "200");
    expect(fadeIn()).toHaveAttribute("aria-valuemax", "4000");
    expect(fadeOut()).toHaveAttribute("aria-valuemax", "3800");
    expect(volume()).toHaveAccessibleName("Volume of take.wav, 0.0 dB");
    expect(volume()).toHaveAttribute("aria-orientation", "vertical");
    await expectNoA11yViolations();
  });

  it("drags the fade in as one undo step, the fade drawn as it goes", () => {
    renderClip();
    const handle = fadeIn();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 200 });
    // A press that has not moved leaves no undo step.
    expect(lanesNow().canUndo).toBe(false);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 220 });
    expect(clipNow().fadeIn.ms).toBe(200);
    // The clip draws its fade from the live value: 20 px wide at 100 px a second.
    const clip = screen.getByTestId("clip-clip-a");
    expect(clip.querySelector<HTMLElement>("[style*='width: 20px']")).not.toBeNull();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(clipNow().fadeIn.ms).toBe(500);
    expect(fadeIn()).toHaveAccessibleName("Fade in of take.wav, 500 ms");
    act(() => void lanesNow().undo());
    expect(clipNow().fadeIn.ms).toBe(0);
    expect(lanesNow().canUndo).toBe(false);
  });

  it("drags the fade out inward and clamps fades to the clip", () => {
    renderClip({ fadeIn: { ms: 1000, shape: "linear" } });
    drag(fadeOut(), { x: 600 }, [{ x: 570 }]);
    expect(clipNow().fadeOut.ms).toBe(300);
    // Further in than the fade in allows, then out past the clip's end.
    drag(fadeOut(), { x: 570 }, [{ x: 0 }]);
    expect(clipNow().fadeOut.ms).toBe(3000);
    drag(fadeOut(), { x: 570 }, [{ x: 900 }]);
    expect(clipNow().fadeOut.ms).toBe(0);
  });

  it("makes a crossfade the user's own when its length is dragged", () => {
    renderClip({ fadeIn: { ms: 300, shape: "equalPower", auto: true } });
    drag(fadeIn(), { x: 230 }, [{ x: 300 }]);
    expect(clipNow().fadeIn).toEqual({ ms: 1000, shape: "equalPower" });
  });

  it("drags the top edge for volume, finer with Shift, and resets on double-click", () => {
    renderClip();
    drag(volume(), { y: 100 }, [{ y: 80 }, { y: 60, shift: true }]);
    // 20 px up at 0.25 dB a pixel, then 20 px at a tenth of that.
    expect(clipNow().gainDb).toBe(5.5);
    expect(volume()).toHaveAccessibleName("Volume of take.wav, +5.5 dB");
    drag(volume(), { y: 0 }, [{ y: 10_000 }]);
    expect(clipNow().gainDb).toBe(-60);
    fireEvent.doubleClick(volume());
    expect(clipNow().gainDb).toBe(0);
    act(() => void lanesNow().undo());
    act(() => void lanesNow().undo());
    expect(clipNow().gainDb).toBe(5.5);
  });

  it("changes fades and volume with the keyboard", async () => {
    const { user } = renderClip();
    fadeIn().focus();
    await user.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    expect(clipNow().fadeIn.ms).toBe(55);
    await user.keyboard("{End}");
    expect(clipNow().fadeIn.ms).toBe(4000);
    await user.keyboard("{Delete}");
    expect(clipNow().fadeIn.ms).toBe(0);
    volume().focus();
    await user.keyboard("{ArrowUp}{ArrowUp}{Shift>}{ArrowDown}{/Shift}");
    expect(clipNow().gainDb).toBe(1.9);
  });

  it("removes a fade on ⌥-click", () => {
    renderClip({ fadeOut: { ms: 800, shape: "sCurve" } });
    fireEvent.pointerDown(fadeOut(), { button: 0, pointerId: 1, altKey: true, clientX: 520 });
    expect(clipNow().fadeOut).toEqual({ ms: 0, shape: "linear" });
  });

  it("has no handles on a locked clip", () => {
    renderClip({ locked: true });
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("has no handles on a clip narrower than 40 px", () => {
    // 4 s at 5 px a second: 20 px.
    renderClip({}, 0.005);
    expect(screen.queryByRole("slider")).toBeNull();
  });
});

describe("ClipHandles in the track list", () => {
  const renderRow = () =>
    renderWithProviders(
      <Lanes audio={song({ fadeIn: { ms: 400, shape: "linear" } })}>
        {(lanes) => (
          <ul>
            {lanes.audio.lanes.map((lane, index) => (
              <LaneRow
                key={lane.id}
                lanes={lanes}
                lane={lane}
                index={index}
                barWidth={40}
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

  it("opens the fade's own menu on right-click, not the lane's", async () => {
    const { user } = renderRow();
    fireEvent.contextMenu(fadeIn());
    const menu = await screen.findByRole("menu", { name: "Fade in shape" });
    expect(screen.queryByRole("menu", { name: "Lane actions: Vocals" })).toBeNull();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Linear (current)", "Equal power", "S-curve", "Remove fade"]);
    await expectNoA11yViolations();
    await user.click(within(menu).getByRole("menuitem", { name: "S-curve" }));
    expect(clipNow().fadeIn).toEqual({ ms: 400, shape: "sCurve" });

    fireEvent.contextMenu(fadeIn());
    await user.click(await screen.findByRole("menuitem", { name: "Remove fade" }));
    expect(clipNow().fadeIn.ms).toBe(0);
  });

  it("opens the clip's lane menu on a right-click on the volume edge", async () => {
    renderRow();
    fireEvent.contextMenu(volume());
    const menu = await screen.findByRole("menu", { name: "Lane actions: Vocals" });
    expect(within(menu).getByRole("menuitem", { name: /^Cut/ })).toBeInTheDocument();
  });

  it("keeps a click on a handle from moving the edit cursor", () => {
    renderRow();
    act(() => lanesNow().setEditCursorMs(0));
    fireEvent.click(volume(), { clientX: 120 });
    expect(lanesNow().editCursorMs).toBe(0);
  });
});
