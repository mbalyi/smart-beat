import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CLIP_SHORTCUTS } from "@/components/audio-lanes/clip-keys";
import { LaneRow } from "@/components/audio-lanes/lane-row";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, clipEndMs, newClip, newLane } from "@/lib/audio-lanes/model";
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
const SOURCE = {
  id: "a".repeat(64),
  name: "take.wav",
  ext: "wav",
  path: "/music/take.wav",
  embedded: true,
};

/** Vocals holds `take.wav` (2–6 s), Drums holds `beat.wav` (1–7 s). */
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
        clips: [newClip(SOURCE.id, "beat.wav", 1000, 6000, "clip-b")],
      },
    ],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;
const clipA = () => lanesNow().audio.lanes[0]!.clips[0]!;
const clipB = () => lanesNow().audio.lanes[1]!.clips[0]!;

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

const renderRows = () =>
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

const vocals = () => screen.getByRole("button", { name: /take\.wav on Vocals/ });

async function openMenu() {
  fireEvent.contextMenu(vocals());
  return screen.findByRole("menu", { name: "Lane actions: Vocals" });
}

describe("Trim to the position line: right-click menu", () => {
  it("trims the start of the clip it was opened on to the line, right under Split", async () => {
    const { user } = renderRows();
    act(() => lanesNow().setEditCursorMs(3000));
    const menu = await openMenu();
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    const split = names.findIndex((n) => n?.startsWith("Split at the position line"));
    expect(names[split + 1]).toBe("Trim start to the position line[");
    expect(names[split + 2]).toBe("Trim end to the position line]");
    await user.click(within(menu).getByRole("menuitem", { name: /Trim start to the position/ }));
    expect(clipA()).toMatchObject({ startMs: 3000, lengthMs: 3000 });
    // The other lane's clip under the line is not part of the selection: it stays.
    expect(clipB()).toMatchObject({ startMs: 1000, lengthMs: 6000 });
    await expectNoA11yViolations();
  });

  it("trims the end of the clip to the line", async () => {
    const { user } = renderRows();
    act(() => lanesNow().setEditCursorMs(5000));
    await openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /Trim end to the position/ }));
    expect(clipA()).toMatchObject({ startMs: 2000, lengthMs: 3000 });
    expect(clipEndMs(clipA())).toBe(5000);
  });

  it("offers no trim when the line is outside the clip", async () => {
    renderRows();
    act(() => lanesNow().setEditCursorMs(9000));
    const menu = await openMenu();
    for (const name of [/Trim start to the position/, /Trim end to the position/])
      expect(within(menu).getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
  });

  it("offers no trim on a locked clip", async () => {
    renderRows();
    act(() => lanesNow().setEditCursorMs(3000));
    act(() => lanesNow().apply((a) => ({ ...a, lanes: lockFirst(a.lanes) })));
    const menu = await openMenu();
    expect(
      within(menu).getByRole("menuitem", { name: /Trim start to the position/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});

const lockFirst = (lanes: AudioLanesSettings["lanes"]) =>
  lanes.map((lane, i) =>
    i === 0 ? { ...lane, clips: lane.clips.map((c) => ({ ...c, locked: true })) } : lane,
  );

describe("Trim to the position line: keys", () => {
  it("lists [ and ] in the clip shortcuts", () => {
    expect(CLIP_SHORTCUTS.map((s) => s.keys)).toContain("[ ]");
  });

  it("trims the focused clip's start with [ and its end with ], each one undo step", async () => {
    const { user } = renderRows();
    await user.click(vocals());
    act(() => lanesNow().setEditCursorMs(3000));
    // `[[` types one `[` (a single one opens a key name).
    await user.keyboard("[[");
    expect(clipA()).toMatchObject({ startMs: 3000, lengthMs: 3000 });
    act(() => lanesNow().setEditCursorMs(5000));
    await user.keyboard("]");
    expect(clipA()).toMatchObject({ startMs: 3000, lengthMs: 2000 });
    act(() => void lanesNow().undo());
    expect(clipA()).toMatchObject({ startMs: 3000, lengthMs: 3000 });
    act(() => void lanesNow().undo());
    expect(clipA()).toMatchObject({ startMs: 2000, lengthMs: 4000 });
  });

  it("does nothing when the line is not in the clip", async () => {
    const { user } = renderRows();
    await user.click(vocals());
    act(() => lanesNow().setEditCursorMs(9000));
    await user.keyboard("]");
    expect(clipA()).toMatchObject({ startMs: 2000, lengthMs: 4000 });
    expect(lanesNow().canUndo).toBe(false);
  });
});

describe("Trim to the position line: commands", () => {
  it("trims every selected clip under the line in one undo step", () => {
    renderRows();
    act(() => lanesNow().setEditCursorMs(4000));
    act(() => lanesNow().select(["clip-a", "clip-b"]));
    act(() => lanesNow().commands.trimStartToLine());
    expect(clipA().startMs).toBe(4000);
    expect(clipB().startMs).toBe(4000);
    act(() => void lanesNow().undo());
    expect(clipA().startMs).toBe(2000);
    expect(clipB().startMs).toBe(1000);
  });

  it("trims every clip under the line when nothing is selected", () => {
    renderRows();
    act(() => lanesNow().setEditCursorMs(4000));
    act(() => lanesNow().commands.trimEndToLine());
    expect(clipEndMs(clipA())).toBe(4000);
    expect(clipEndMs(clipB())).toBe(4000);
  });
});
