import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { LaneEditorDock } from "@/components/audio-lanes/lane-editor-dock";
import { StudioView } from "@/components/audio-lanes/studio-view";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { markersOf, regionsOf } from "@/lib/audio-lanes/markers";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
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

function song(extra: Partial<AudioLanesSettings> = {}): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a")],
      },
    ],
    ...extra,
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;

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

function renderStudio(audio = song()) {
  return renderWithProviders(
    <Lanes audio={audio}>
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

const marker = (id: string, ms: number, name: string) => ({ id, ms, name });
const names = () => markersOf(lanesNow().audio).map((m) => m.name);

describe("studio markers", () => {
  it("adds markers with the button and M, names one with Shift+M, and jumps between them", async () => {
    const { user } = renderStudio();
    const studio = screen.getByRole("dialog", { name: "Studio" });
    act(() => lanesNow().setEditCursorMs(3000));
    await user.click(within(studio).getByRole("button", { name: "Marker" }));
    expect(markersOf(lanesNow().audio)).toMatchObject([{ ms: 3000, name: "Marker 1" }]);

    act(() => lanesNow().setEditCursorMs(1000));
    await user.keyboard("m");
    expect(names()).toEqual(["Marker 2", "Marker 1"]);

    act(() => lanesNow().setEditCursorMs(6000));
    await user.keyboard("{Shift>}M{/Shift}");
    const field = await screen.findByRole("textbox", { name: "Name of Marker 3" });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "Chorus{Enter}");
    expect(names()).toEqual(["Marker 2", "Marker 1", "Chorus"]);

    // Keys typed into the field never reached the shortcuts.
    expect(markersOf(lanesNow().audio)).toHaveLength(3);

    within(studio).getByRole("button", { name: "Marker" }).focus();
    act(() => lanesNow().setEditCursorMs(0));
    await user.keyboard(".");
    expect(lanesNow().editCursorMs).toBe(1000);
    await user.keyboard(".");
    expect(lanesNow().editCursorMs).toBe(3000);
    await user.keyboard(",");
    expect(lanesNow().editCursorMs).toBe(1000);
    await user.keyboard("3");
    expect(lanesNow().editCursorMs).toBe(6000);
    await expectNoA11yViolations();
  });

  it("goes to, renames and deletes from the side panel list", async () => {
    const { user } = renderStudio(
      song({ markers: [marker("m1", 1000, "Intro"), marker("m2", 4000, "Verse")] }),
    );
    const list = screen.getByRole("complementary", { name: "Markers and regions" });
    await user.click(within(list).getByRole("button", { name: "Go to Verse, 0:04.00" }));
    expect(lanesNow().editCursorMs).toBe(4000);
    await user.click(within(list).getByRole("button", { name: "Rename Intro" }));
    const field = within(list).getByRole("textbox", { name: "Name of Intro" });
    await user.clear(field);
    await user.type(field, "Count-in{Enter}");
    expect(names()).toEqual(["Count-in", "Verse"]);
    await user.click(within(list).getByRole("button", { name: "Delete Verse" }));
    expect(names()).toEqual(["Count-in"]);
    await expectNoA11yViolations();
  });

  it("drags a marker (snapped), renames it with a double-click and removes it with ⌥-click", async () => {
    const { user } = renderStudio(song({ markers: [marker("m1", 1000, "Intro")] }));
    const flag = screen.getByTestId("marker-m1");
    // 40 px a second: 82 px is 2050 ms, snapped to the beat (500 ms).
    fireEvent.pointerDown(flag, { button: 0, clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 82 });
    fireEvent.pointerUp(window, { clientX: 82 });
    expect(markersOf(lanesNow().audio)[0]!.ms).toBe(3000);
    act(() => void lanesNow().undo());
    expect(markersOf(lanesNow().audio)[0]!.ms).toBe(1000);

    await user.dblClick(screen.getByTestId("marker-m1"));
    const field = screen.getByRole("textbox", { name: "Name of Intro" });
    await user.clear(field);
    await user.type(field, "Start{Escape}");
    expect(names()).toEqual(["Intro"]);

    await user.keyboard("{Alt>}");
    await user.click(screen.getByTestId("marker-m1"));
    await user.keyboard("{/Alt}");
    expect(markersOf(lanesNow().audio)).toEqual([]);
  });

  it("offers Rename, Go to and Delete on a marker's right-click menu", async () => {
    const { user } = renderStudio(song({ markers: [marker("m1", 5000, "Bridge")] }));
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("marker-m1") });
    await user.click(await screen.findByRole("menuitem", { name: "Go to" }));
    expect(lanesNow().editCursorMs).toBe(5000);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("marker-m1") });
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(markersOf(lanesNow().audio)).toEqual([]);
  });
});

describe("studio regions", () => {
  it("makes a region from the selected clips and selects its span on a double-click", async () => {
    const { user } = renderStudio();
    const studio = screen.getByRole("dialog", { name: "Studio" });
    expect(
      within(studio).getByRole("button", { name: "Region from the selected clips" }),
    ).toBeDisabled();
    act(() => lanesNow().select(["clip-a"]));
    await user.click(
      within(studio).getByRole("button", { name: "Region from the selected clips" }),
    );
    const [region] = regionsOf(lanesNow().audio);
    expect(region).toMatchObject({ startMs: 2000, endMs: 6000, name: "Region 1" });

    await user.dblClick(screen.getByTestId(`region-${region!.id}`));
    expect(lanesNow().editCursorMs).toBe(2000);
    expect(screen.getByTestId("range-bar")).toHaveTextContent("Range 2.00 s – 6.00 s");
    // With a time selection the region comes from it.
    expect(
      within(studio).getByRole("button", { name: "Region from the time selection" }),
    ).toBeEnabled();
    await expectNoA11yViolations();
  });
});

describe("lane editor markers", () => {
  it("shows the compact marker row and takes the marker keys", async () => {
    const { user } = renderWithProviders(
      <Lanes audio={song({ markers: [marker("m1", 4000, "Solo")] })}>
        {(lanes) => (
          <LaneEditorDock
            lanes={lanes}
            lane={lanes.audio.lanes[0]!}
            index={0}
            grid={grid}
            scoreBpmAt={() => 120}
            playing={false}
            selectedBars={null}
            onSelectBars={vi.fn()}
            onSeekBar={vi.fn()}
            actions={{
              syncFromScoreTempo: vi.fn(() => []),
              tempoFromSync: vi.fn(),
              syncFromBeats: vi.fn(),
              replaceFile: vi.fn(),
              extract: vi.fn(),
              addBar: vi.fn(),
              effects: vi.fn(),
              openStudio: vi.fn(),
              close: vi.fn(),
            }}
          />
        )}
      </Lanes>,
    );
    const editor = screen.getByRole("region", { name: "Lane editor: Vocals" });
    const row = within(editor).getByRole("group", { name: "Markers and regions" });
    expect(within(row).getByRole("button", { name: "Marker 1: Solo, 0:04.00" })).toBeVisible();
    within(editor).getByRole("button", { name: "Zoom in" }).focus();
    await user.keyboard("1");
    expect(lanesNow().editCursorMs).toBe(4000);
    act(() => lanesNow().setEditCursorMs(7000));
    await user.keyboard("m");
    expect(names()).toEqual(["Solo", "Marker 1"]);
    // A focused clip keeps M for mute.
    await user.click(within(editor).getByRole("button", { name: /take\.wav on Vocals/ }));
    await user.keyboard("m");
    expect(lanesNow().audio.lanes[0]!.clips[0]!.mute).toBe(true);
    expect(markersOf(lanesNow().audio)).toHaveLength(2);
    await expectNoA11yViolations();
  });
});
