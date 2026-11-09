import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { normalizeGainDb } from "@/components/audio-lanes/clip-properties";
import { LaneColorPopover } from "@/components/audio-lanes/lane-color-popover";
import { LaneEditorDock, type LaneEditorActions } from "@/components/audio-lanes/lane-editor-dock";
import { LaneRow } from "@/components/audio-lanes/lane-row";
import { RecordAudioDialog } from "@/components/audio-lanes/record-audio-dialog";
import { StudioView } from "@/components/audio-lanes/studio-view";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
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

function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a")],
      },
      newLane("Drums", "lane-b"),
    ],
  };
}

/** Runs the real lanes hook over a mix and hands the controller to `children`. */
function Lanes({
  children,
  audio = song(),
}: {
  children: (lanes: AudioLanesController) => ReactNode;
  audio?: AudioLanesSettings;
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
  latest.lanes = lanes;
  return <>{children(lanes)}</>;
}
const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;

describe("LaneColorPopover", () => {
  it("offers the stem colours first, a custom colour and the default", async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <LaneColorPopover laneName="Vocals" index={0} color={null} onChange={onChange} />,
    );
    await user.click(screen.getByRole("button", { name: "Colour of Vocals" }));
    const stems = screen.getByRole("group", { name: "Stem colours" });
    expect(
      within(stems)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Guitar", "Drums", "Bass", "Vocals", "Piano", "Guitars and keys", "Other"]);
    await user.click(within(stems).getByRole("button", { name: "Vocals" }));
    expect(onChange).toHaveBeenCalledWith("#ffd21a");
    expect(screen.getByRole("button", { name: "Default colour" })).toBeDisabled();
    await expectNoA11yViolations();
  });
});

describe("LaneRow clips", () => {
  const renderRow = () =>
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

  it("splits a clip at the edit cursor, glues it back and undoes", async () => {
    const { user } = renderRow();
    act(() => lanesNow().setEditCursorMs(3000));
    const clip = screen.getByRole("button", { name: /take\.wav on Vocals/ });
    await user.click(clip);
    await user.keyboard("s");
    await vi.waitFor(() => expect(lanesNow().audio.lanes[0]!.clips).toHaveLength(2));
    const [left, right] = lanesNow().audio.lanes[0]!.clips;
    expect(right!.startMs).toBe(3000);
    act(() => lanesNow().select([left!.id, right!.id]));
    act(() => lanesNow().commands.glue());
    expect(lanesNow().audio.lanes[0]!.clips).toHaveLength(1);
    act(() => void lanesNow().undo());
    expect(lanesNow().audio.lanes[0]!.clips).toHaveLength(2);
  });

  it("mutes, locks and nudges a focused clip with keys, and deletes it", async () => {
    const { user } = renderRow();
    await user.click(screen.getByRole("button", { name: /take\.wav on Vocals/ }));
    await user.keyboard("m");
    expect(lanesNow().audio.lanes[0]!.clips[0]!.mute).toBe(true);
    await user.keyboard("{ArrowRight}");
    expect(lanesNow().audio.lanes[0]!.clips[0]!.startMs).toBe(2500);
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(lanesNow().audio.lanes[0]!.clips[0]!.startMs).toBe(500);
    await user.keyboard("l");
    await user.keyboard("{ArrowRight}");
    expect(lanesNow().audio.lanes[0]!.clips[0]!.startMs).toBe(500);
    await user.keyboard("{Delete}");
    expect(lanesNow().audio.lanes[0]!.clips).toHaveLength(0);
  });

  it("renames a lane in place and moves it down", async () => {
    const { user } = renderRow();
    const row = screen.getByTestId("lane-row-lane-a");
    await user.click(within(row).getByRole("button", { name: "More for Vocals" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const field = screen.getByRole("textbox", { name: "Name of the lane Vocals" });
    await user.clear(field);
    await user.type(field, "Lead vocal{Enter}");
    expect(lanesNow().audio.lanes[0]!.name).toBe("Lead vocal");
    await user.click(
      within(screen.getByTestId("lane-row-lane-a")).getByRole("button", {
        name: "More for Lead vocal",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(lanesNow().audio.lanes.map((l) => l.id)).toEqual(["lane-b", "lane-a"]);
    await expectNoA11yViolations();
  });
});

describe("LaneEditorDock", () => {
  const actions = (): LaneEditorActions => ({
    syncFromScoreTempo: vi.fn(() => [{ bar: 0, ms: 0 }]),
    tempoFromSync: vi.fn(),
    syncFromBeats: vi.fn(),
    replaceFile: vi.fn(),
    extract: vi.fn(),
    addBar: vi.fn(),
    effects: vi.fn(),
    openStudio: vi.fn(),
    close: vi.fn(),
  });

  it("sets the filter, pitch, sync points and embedding of a lane", async () => {
    const act$ = actions();
    const onSeekBar = vi.fn();
    const { user } = renderWithProviders(
      <Lanes>
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
            onSeekBar={onSeekBar}
            actions={act$}
          />
        )}
      </Lanes>,
    );
    const editor = screen.getByRole("region", { name: "Lane editor: Vocals" });
    await user.selectOptions(
      within(editor).getByRole("combobox", { name: "Filter" }),
      "Mid attenuate",
    );
    expect(lanesNow().audio.lanes[0]!.filter).toBe("midCut");
    // A double-click on a bar's triangle adds a sync point there.
    await user.dblClick(within(editor).getByRole("button", { name: "Sync point at bar 3" }));
    expect(lanesNow().audio.sync).toEqual([{ bar: 2, ms: 4000 }]);
    await user.click(within(editor).getByRole("button", { name: "Play from bar 4" }));
    expect(onSeekBar).toHaveBeenCalledWith(3, false);
    await user.click(within(editor).getByRole("button", { name: "Tasks" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Embed “take.wav” in the song" }),
    );
    expect(lanesNow().audio.sources[0]!.embedded).toBe(false);
    await user.click(within(editor).getByRole("button", { name: "Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Clear sync points" }));
    expect(lanesNow().audio.sync).toEqual([]);
    await user.click(within(editor).getByRole("button", { name: "Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: "Extract “take.wav” as WAV…" }));
    expect(act$.extract).toHaveBeenCalledWith(SOURCE.id, true);
    // The play zone's end bracket moves with the arrow keys.
    fireEvent.keyDown(within(editor).getByRole("button", { name: /Play zone end/ }), {
      key: "ArrowLeft",
    });
    expect(lanesNow().audio.zone.end).toBe(7);
    await expectNoA11yViolations();
  });
});

describe("StudioView", () => {
  it("sets snap and ripple, adds a bus and sends to it, and edits the selected clip", async () => {
    const { user } = renderWithProviders(
      <Lanes>
        {(lanes) => (
          <StudioView
            lanes={lanes}
            grid={grid}
            markers={[{ ms: 0, name: "Intro" }]}
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
    const studio = screen.getByRole("dialog", { name: "Studio" });
    expect(within(studio).getByText("Intro")).toBeInTheDocument();
    await user.selectOptions(within(studio).getByRole("combobox", { name: "Ripple" }), "All lanes");
    expect(lanesNow().audio.ripple).toBe("all");
    await user.click(within(studio).getByRole("button", { name: "Bus" }));
    expect(lanesNow().audio.buses).toHaveLength(1);
    await user.click(within(studio).getAllByRole("button", { name: "Sends" })[0]!);
    const send = await screen.findByRole("slider", { name: "Send to Bus 1" });
    fireEvent.keyDown(send, { key: "ArrowRight" });
    expect(lanesNow().audio.lanes[0]!.sends[0]).toMatchObject({
      bus: lanesNow().audio.buses[0]!.id,
    });
    await user.keyboard("{Escape}");
    await user.click(within(studio).getByRole("button", { name: /take\.wav on Vocals/ }));
    const props = await screen.findByRole("complementary", { name: "Clip properties" });
    await user.click(within(props).getByRole("button", { name: "Reverse" }));
    expect(lanesNow().audio.lanes[0]!.clips[0]!.reversed).toBe(true);
    const gain = within(props).getByRole("spinbutton", { name: "Gain" });
    fireEvent.change(gain, { target: { value: "-6" } });
    expect(lanesNow().audio.lanes[0]!.clips[0]!.gainDb).toBe(-6);
    await expectNoA11yViolations();
  });
});

describe("RecordAudioDialog", () => {
  it("asks for a selection before a punch, and starts with the chosen setup", async () => {
    const onStart = vi.fn();
    const { user } = renderWithProviders(
      <RecordAudioDialog
        open
        onOpenChange={vi.fn()}
        lanes={[{ id: "lane-a", name: "Vocals" }]}
        defaultLane="lane-a"
        inputName="Scarlett 2i2 USB"
        latency="About 11 ms output delay"
        hasSelection={false}
        onStart={onStart}
        onInputSettings={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Record audio" });
    expect(within(dialog).getByText("Scarlett 2i2 USB")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: /Punch in the selection/ }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Select the bars first");
    expect(within(dialog).getByRole("button", { name: "Start recording" })).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: /From the playhead/ }));
    await user.click(within(dialog).getByRole("switch", { name: "Count-in" }));
    await user.click(within(dialog).getByRole("button", { name: "Start recording" }));
    expect(onStart).toHaveBeenCalledWith({
      laneId: "lane-a",
      mode: "playhead",
      countIn: false,
      preRollBars: 0,
    });
  });

  it("has no accessibility problems", async () => {
    renderWithProviders(
      <RecordAudioDialog
        open
        onOpenChange={vi.fn()}
        lanes={[]}
        defaultLane={null}
        inputName="System default"
        latency="About 0 ms output delay"
        hasSelection
        onStart={vi.fn()}
        onInputSettings={vi.fn()}
      />,
    );
    await expectNoA11yViolations();
  });
});

describe("normalizeGainDb", () => {
  it("brings the loudest peak to 0 dB, from the current gain", () => {
    expect(normalizeGainDb([0.25, 0.5], 0)).toBeCloseTo(6, 0);
    // Peaks already carry the clip's gain: +6 dB with a 0.5 peak means the file peaks at 0.25.
    expect(normalizeGainDb([0.5], 6)).toBeCloseTo(12, 0);
    expect(normalizeGainDb([], 3)).toBe(3);
  });
});
