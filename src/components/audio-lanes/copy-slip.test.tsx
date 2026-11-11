import { act, fireEvent, screen } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLIP_SHORTCUTS } from "@/components/audio-lanes/clip-keys";
import { LaneRow } from "@/components/audio-lanes/lane-row";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, activeTake, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioClip, AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { renderWithProviders } from "@/test/render";

/** Eight bars of 4/4 at 120 bpm: a bar is 2 s, a beat 500 ms. */
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

/** Clip "clip-a" plays 4 s of the file from 2 s, at 2 s on lane "Vocals"; "Drums" is empty. */
function song(patch: Partial<AudioClip> = {}): AudioLanesSettings {
  const clip = newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a");
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [{ ...clip, takes: [{ ...clip.takes[0]!, offsetMs: 2000 }], ...patch }],
      },
      newLane("Drums", "lane-b"),
    ],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;

function Lanes({
  audio,
  children,
}: {
  audio: AudioLanesSettings;
  children: (l: AudioLanesController) => ReactNode;
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

/** The lanes as rows at 20 px a bar (10 px a second). */
function renderRows(audio = song()) {
  return renderWithProviders(
    <Lanes audio={audio}>
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
}

const clipButton = () => screen.getByRole("button", { name: /take\.wav on Vocals/ });
const laneClips = (index: number) => lanesNow().audio.lanes[index]!.clips;
const offsetOf = (c: AudioClip) => activeTake(c).offsetMs;

/** Presses on the clip with `keys` held, drags it `dx` px and lets go. */
function drag(dx: number, keys: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) {
  const clip = clipButton();
  fireEvent.pointerDown(clip, { button: 0, pointerId: 1, clientX: 40, clientY: 10, ...keys });
  fireEvent.pointerMove(clip, { pointerId: 1, clientX: 40 + dx, clientY: 10, ...keys });
  return () => fireEvent.pointerUp(clip, { pointerId: 1, clientX: 40 + dx, clientY: 10 });
}

afterEach(() => {
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("copy-drag", () => {
  it("copies a clip with ⌘-drag: the original stays and a snapped copy lands", () => {
    renderRows();
    // 41 px is 4.1 s later: the copy snaps to the beat at 6 s.
    const release = drag(41, { metaKey: true });
    expect(clipButton()).toHaveAttribute("data-drag", "copy");
    expect(screen.getByTestId("clip-copy-badge")).toHaveTextContent("+");
    expect(screen.getByTestId("clip-copy-ghost")).toBeInTheDocument();
    expect(clipButton().className).toContain("cursor-copy");
    release();
    expect(laneClips(0).map((c) => c.startMs)).toEqual([2000, 6000]);
    expect(laneClips(0)[1]!.id).not.toBe("clip-a");
    expect(screen.queryByTestId("clip-copy-badge")).not.toBeInTheDocument();
  });

  it("copies to the lane it is dropped on with Ctrl-drag, and undoes in one step", () => {
    renderRows();
    const drums = screen
      .getByTestId("lane-row-lane-b")
      .querySelector<HTMLElement>("[data-lane-id]")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => drums });
    drag(20, { ctrlKey: true })();
    expect(laneClips(0).map((c) => c.id)).toEqual(["clip-a"]);
    expect(laneClips(1).map((c) => c.startMs)).toEqual([4000]);
    act(() => void lanesNow().undo());
    expect(laneClips(1)).toHaveLength(0);
  });
});

describe("slip-drag", () => {
  it("slides the audio inside the clip with ⌥-drag and leaves the clip in place", () => {
    renderRows();
    // 5 px left is 500 ms: the clip now starts 500 ms later in its file.
    const release = drag(-5, { altKey: true });
    expect(clipButton()).toHaveAttribute("data-drag", "slip");
    expect(clipButton().className).toContain("cursor-ew-resize");
    release();
    const [clip] = laneClips(0);
    expect(clip!.startMs).toBe(2000);
    expect(offsetOf(clip!)).toBe(2500);
  });

  it("slides a reversed clip's file position the other way", () => {
    renderRows(song({ reversed: true }));
    drag(-5, { altKey: true })();
    expect(offsetOf(laneClips(0)[0]!)).toBe(1500);
  });

  it("does not copy or slip a locked clip", () => {
    renderRows(song({ locked: true }));
    drag(40, { metaKey: true })();
    drag(-5, { altKey: true })();
    expect(laneClips(0)).toHaveLength(1);
    expect(offsetOf(laneClips(0)[0]!)).toBe(2000);
    expect(clipButton()).not.toHaveAttribute("data-drag");
  });
});

describe("slip keys", () => {
  it("slips by a beat with ⌥← ⌥→ and by a bar with ⌥⇧, clamped at the file's start", async () => {
    const { user } = renderRows();
    await user.click(clipButton());
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(offsetOf(laneClips(0)[0]!)).toBe(2500);
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(offsetOf(laneClips(0)[0]!)).toBe(2000);
    await user.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
    expect(offsetOf(laneClips(0)[0]!)).toBe(0);
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(offsetOf(laneClips(0)[0]!)).toBe(0);
    // The clip itself never moved.
    expect(laneClips(0)[0]!.startMs).toBe(2000);
  });

  it("lists the slip keys with the clip shortcuts", () => {
    expect(CLIP_SHORTCUTS.map((s) => s.keys)).toContain("⌥← ⌥→");
  });
});
