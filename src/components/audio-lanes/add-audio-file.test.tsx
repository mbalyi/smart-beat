import { act, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LaneEditorDock, type LaneEditorActions } from "@/components/audio-lanes/lane-editor-dock";
import { LaneRow } from "@/components/audio-lanes/lane-row";
import { StudioView } from "@/components/audio-lanes/studio-view";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { renderWithProviders } from "@/test/render";

const pickAudioFile = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock("@/lib/tauri", async (original) => ({ ...(await original<object>()), pickAudioFile }));

const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const SOURCE = { id: "a".repeat(64), name: "take.wav", ext: "wav", embedded: true };
// A file that is loaded already (the take on the first lane) is described under its own id.
const loadSource = vi.fn(async (location: { type: string; id?: string }) => ({
  id: location.type === "pool" ? location.id! : "c".repeat(64),
  ext: "wav",
  durationMs: 1000,
  sampleRate: 44_100,
  channels: 2,
  peaks: [],
}));

const song = (): AudioLanesSettings => ({
  ...EMPTY_AUDIO,
  sources: [SOURCE],
  lanes: [
    {
      ...newLane("Vocals", "lane-a"),
      clips: [
        newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a"),
        newClip(SOURCE.id, "take.wav", 0, 1000, "clip-b"),
      ],
    },
    newLane("Drums", "lane-b"),
  ],
});

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;

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
    loadSource: loadSource as never,
    epoch: null,
    songPath: null,
    grid,
  });
  useEffect(() => {
    latest.lanes = lanes;
  });
  return <>{children(lanes)}</>;
}

const startsOf = (laneId: string) =>
  lanesNow()
    .audio.lanes.find((l) => l.id === laneId)!
    .clips.map((c) => c.startMs);

const studioActions = {
  playPause: vi.fn(),
  record: vi.fn(),
  effects: vi.fn(),
  renderLanes: vi.fn(),
  renderRange: vi.fn(),
  close: vi.fn(),
};

const rowFor = (lanes: AudioLanesController, index: number) => (
  <LaneRow
    key={lanes.audio.lanes[index]!.id}
    lanes={lanes}
    lane={lanes.audio.lanes[index]!}
    index={index}
    barWidth={20}
    barCount={8}
    grid={grid}
    playing={false}
    onEffects={vi.fn()}
    onOpenEditor={vi.fn()}
  />
);

describe("Add audio file", () => {
  beforeEach(() => {
    pickAudioFile.mockReset();
    pickAudioFile.mockResolvedValue("/music/take2.wav");
    loadSource.mockClear();
  });

  it("adds a file from a lane's menu after its last clip", async () => {
    const { user } = renderWithProviders(<Lanes>{(lanes) => <ul>{rowFor(lanes, 0)}</ul>}</Lanes>);
    await user.click(screen.getByRole("button", { name: "More for Vocals" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add audio file…" }));
    // The last clip of Vocals ends at 6 s.
    await vi.waitFor(() => expect(startsOf("lane-a")).toContain(6000));
    expect(loadSource).toHaveBeenCalledWith({ type: "file", path: "/music/take2.wav" });
  });

  it("starts an empty lane's file at 0", async () => {
    const { user } = renderWithProviders(<Lanes>{(lanes) => <ul>{rowFor(lanes, 1)}</ul>}</Lanes>);
    await user.click(screen.getByRole("button", { name: "More for Drums" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add audio file…" }));
    await vi.waitFor(() => expect(startsOf("lane-b")).toEqual([0]));
  });

  it("adds a file from the lane editor next to Replace file", async () => {
    const actions: LaneEditorActions = {
      syncFromScoreTempo: vi.fn(() => []),
      tempoFromSync: vi.fn(),
      syncFromBeats: vi.fn(),
      replaceFile: vi.fn(),
      extract: vi.fn(),
      addBar: vi.fn(),
      effects: vi.fn(),
      openStudio: vi.fn(),
      close: vi.fn(),
    };
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
            onSeekBar={vi.fn()}
            actions={actions}
          />
        )}
      </Lanes>,
    );
    const editor = screen.getByRole("region", { name: "Lane editor: Vocals" });
    await user.click(within(editor).getByRole("button", { name: "Add audio file" }));
    await vi.waitFor(() => expect(startsOf("lane-a")).toContain(6000));
    expect(actions.replaceFile).not.toHaveBeenCalled();
  });

  it("adds a file from a studio lane header", async () => {
    const { user } = renderWithProviders(
      <Lanes>
        {(lanes) => (
          <StudioView
            lanes={lanes}
            grid={grid}
            markers={[]}
            playing={false}
            position="1"
            actions={studioActions}
          />
        )}
      </Lanes>,
    );
    await user.click(screen.getByRole("button", { name: "Add audio file to Drums" }));
    await vi.waitFor(() => expect(startsOf("lane-b")).toEqual([0]));
  });

  it("does nothing when the chooser is cancelled", async () => {
    pickAudioFile.mockResolvedValue(null);
    const { user } = renderWithProviders(
      <Lanes>
        {(lanes) => (
          <StudioView
            lanes={lanes}
            grid={grid}
            markers={[]}
            playing={false}
            position="1"
            actions={studioActions}
          />
        )}
      </Lanes>,
    );
    // The take on the first lane was asked of the loaded copy when the song opened.
    await act(async () => undefined);
    loadSource.mockClear();
    await user.click(screen.getByRole("button", { name: "Add audio file to Drums" }));
    await act(async () => undefined);
    expect(loadSource).not.toHaveBeenCalled();
    expect(startsOf("lane-b")).toEqual([]);
  });
});
