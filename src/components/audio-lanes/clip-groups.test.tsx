import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CLIP_SHORTCUTS } from "@/components/audio-lanes/clip-keys";
import { LaneRow } from "@/components/audio-lanes/lane-row";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioClip, AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

/** Eight bars of 4/4 at 120 bpm (a beat is 500 ms). */
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

const grouped = (clip: AudioClip, groupId: string): AudioClip => ({ ...clip, groupId });

/** Vocals: "one" (grouped) and "three"; Drums: "two" (grouped with "one"). */
function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [
          grouped(newClip(SOURCE.id, "one.wav", 2000, 2000, "one"), "g1"),
          newClip(SOURCE.id, "three.wav", 8000, 2000, "three"),
        ],
      },
      {
        ...newLane("Drums", "lane-b"),
        clips: [grouped(newClip(SOURCE.id, "two.wav", 2000, 2000, "two"), "g1")],
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

const allClips = () => lanesNow().audio.lanes.flatMap((l) => l.clips);
const clipById = (id: string) => allClips().find((c) => c.id === id)!;
const clipButton = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

describe("clip groups", () => {
  it("shows grouped clips with a link mark and says so", async () => {
    renderRows();
    expect(clipButton("one\\.wav on Vocals")).toHaveAccessibleName("one.wav on Vocals, grouped");
    expect(clipButton("two\\.wav on Drums")).toHaveAccessibleName("two.wav on Drums, grouped");
    expect(clipButton("three\\.wav")).toHaveAccessibleName("three.wav on Vocals");
    expect(within(clipButton("one\\.wav")).getByTestId("clip-group-mark")).toBeInTheDocument();
    expect(within(clipButton("three\\.wav")).queryByTestId("clip-group-mark")).toBeNull();
    await expectNoA11yViolations();
  });

  it("selects the whole group on a click, and just the clip with Option", async () => {
    const { user } = renderRows();
    await user.click(clipButton("one\\.wav"));
    expect([...lanesNow().selection].sort()).toEqual(["one", "two"]);
    expect(clipButton("two\\.wav")).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Alt>}");
    await user.click(clipButton("two\\.wav"));
    await user.keyboard("{/Alt}");
    expect(lanesNow().selection).toEqual(["two"]);
  });

  it("nudges and deletes the whole group", async () => {
    const { user } = renderRows();
    await user.click(clipButton("one\\.wav"));
    await user.keyboard("{ArrowRight}");
    expect([clipById("one").startMs, clipById("two").startMs]).toEqual([2500, 2500]);
    expect(clipById("three").startMs).toBe(8000);
    await user.keyboard("{Delete}");
    expect(allClips().map((c) => c.id)).toEqual(["three"]);
  });

  it("nudges nothing when a member is locked", async () => {
    const { user } = renderRows();
    await user.keyboard("{Alt>}");
    await user.click(clipButton("two\\.wav"));
    await user.keyboard("{/Alt}");
    await user.keyboard("l");
    expect(clipById("two").locked).toBe(true);
    await user.click(clipButton("one\\.wav"));
    await user.keyboard("{ArrowRight}");
    expect([clipById("one").startMs, clipById("two").startMs]).toEqual([2000, 2000]);
  });

  it("groups the selection with ⌘G and ungroups it with ⌘⇧G", async () => {
    const { user } = renderRows();
    await user.click(clipButton("one\\.wav"));
    await user.keyboard("{Control>}{Shift>}g{/Shift}{/Control}");
    expect(allClips().every((c) => !c.groupId)).toBe(true);
    expect(clipButton("one\\.wav")).toHaveAccessibleName("one.wav on Vocals");

    act(() => lanesNow().select(["one", "three"]));
    await user.keyboard("{Control>}g{/Control}");
    const id = clipById("one").groupId;
    expect(id).toBeTruthy();
    expect(clipById("three").groupId).toBe(id);
    expect(clipById("two").groupId).toBeUndefined();
    // Undo takes the group back in one step.
    act(() => void lanesNow().undo());
    expect(clipById("three").groupId).toBeUndefined();
  });

  it("lists the group keys with the clip shortcuts", () => {
    expect(CLIP_SHORTCUTS.map((s) => s.keys)).toEqual(expect.arrayContaining(["⌘G", "⌘⇧G", "G"]));
  });

  it("ungroups from the right-click menu", async () => {
    const { user } = renderRows();
    fireEvent.contextMenu(clipButton("one\\.wav"));
    const menu = await screen.findByRole("menu", { name: "Lane actions: Vocals" });
    expect(within(menu).getByText("2 clips · Vocals")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: /^Ungroup/ }));
    expect(allClips().every((c) => !c.groupId)).toBe(true);
  });

  it("groups from the right-click menu, where Ungroup waits for a group", async () => {
    const { user } = renderRows();
    act(() => lanesNow().select(["three", "one"], true));
    fireEvent.contextMenu(clipButton("three\\.wav"));
    const menu = await screen.findByRole("menu", { name: "Lane actions: Vocals" });
    await user.click(within(menu).getByRole("menuitem", { name: /^Group/ }));
    const id = clipById("three").groupId;
    expect(id).toBeTruthy();
    expect(id).not.toBe("g1");
    // "one" left its old group for the new one; "two", left alone, is no longer grouped.
    expect(clipById("one").groupId).toBe(id);
    expect(clipById("two").groupId).toBeUndefined();
  });

  it("offers no Group for a lone clip", async () => {
    renderRows();
    fireEvent.contextMenu(clipButton("three\\.wav"));
    const group = await screen.findByRole("menuitem", { name: /^Group/ });
    expect(group).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /^Ungroup/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("copies and pastes a group as a new group of its own", async () => {
    const { user } = renderRows();
    await user.click(clipButton("one\\.wav"));
    await user.keyboard("{Control>}c{/Control}");
    expect(lanesNow().canPaste).toBe(true);
    act(() => lanesNow().commands.paste("lane-a", 12_000));
    const pasted = allClips().filter((c) => !["one", "two", "three"].includes(c.id));
    expect(pasted.map((c) => c.startMs)).toEqual([12_000, 12_000]);
    expect(pasted[0]!.groupId).toBe(pasted[1]!.groupId);
    expect(pasted[0]!.groupId).not.toBe("g1");
    expect(clipById("one").groupId).toBe("g1");
  });

  it("duplicates a group as a new group of its own", async () => {
    const { user } = renderRows();
    await user.click(clipButton("two\\.wav"));
    await user.keyboard("{Control>}d{/Control}");
    const copies = allClips().filter((c) => !["one", "two", "three"].includes(c.id));
    expect(copies).toHaveLength(2);
    expect(copies[0]!.groupId).toBe(copies[1]!.groupId);
    expect(copies[0]!.groupId).not.toBe("g1");
  });

  it("drags a grouped clip and its group follows", () => {
    renderRows();
    const one = clipButton("one\\.wav");
    // The clip is 40 px wide from x 0; a press in its middle moves it (not a trim).
    vi.spyOn(one, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 40,
      height: 20,
    } as DOMRect);
    // 20 px a bar of 2 s: 10 px later is 1 s later.
    fireEvent.pointerDown(one, { button: 0, clientX: 30, clientY: 5 });
    fireEvent.pointerMove(one, { clientX: 40, clientY: 5 });
    fireEvent.pointerUp(one, { clientX: 40, clientY: 5 });
    expect(clipById("one").startMs).toBe(3000);
    expect(clipById("two").startMs).toBe(3000);
  });
});
