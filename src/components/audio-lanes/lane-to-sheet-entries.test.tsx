import { act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LaneEditorDock, type LaneEditorActions } from "@/components/audio-lanes/lane-editor-dock";
import { LaneRow } from "@/components/audio-lanes/lane-row";
import { LaneToTabProvider } from "@/components/audio-lanes/lane-to-tab-context";
import { StudioView } from "@/components/audio-lanes/studio-view";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { makeFolder } from "@/lib/audio-lanes/edits";
import type { LaneToTabRequest } from "@/lib/audio-lanes/lane-transcribe-request";
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
const SOURCE = {
  id: "a".repeat(64),
  name: "take.wav",
  ext: "wav",
  path: "/music/take.wav",
  embedded: true,
};

/** Vocals with two clips (2 to 4 s and 6 to 8 s), Drums with one (4 to 6 s). */
function song(fade = false): AudioLanesSettings {
  const one = newClip(SOURCE.id, "one.wav", 2000, 2000, "one");
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [
          fade ? { ...one, fadeIn: { ms: 400, shape: "linear" } } : one,
          newClip(SOURCE.id, "two.wav", 6000, 2000, "two"),
        ],
      },
      { ...newLane("Drums", "lane-b"), clips: [newClip(SOURCE.id, "hit.wav", 4000, 2000, "hit")] },
    ],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;

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
    loadSource: () => new Promise(() => {}),
    songPath: null,
    grid,
  });
  useEffect(() => {
    latest.lanes = lanes;
  });
  return <>{children(lanes)}</>;
}

const open = vi.fn<(request: LaneToTabRequest) => void>();

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = { invoke: vi.fn() };
  else delete w.__TAURI_INTERNALS__;
}

beforeEach(() => {
  open.mockReset();
  setTauri(true);
});
afterEach(() => setTauri(false));

function renderRows(audio = song(), provider = true, barWidth = 20) {
  const rows = (
    <Lanes audio={audio}>
      {(lanes) => (
        <ul>
          {lanes.audio.lanes.map((lane, index) => (
            <LaneRow
              key={lane.id}
              lanes={lanes}
              lane={lane}
              index={index}
              barWidth={barWidth}
              barCount={8}
              grid={grid}
              playing={false}
              onEffects={vi.fn()}
              onOpenEditor={vi.fn()}
            />
          ))}
        </ul>
      )}
    </Lanes>
  );
  return renderWithProviders(
    provider ? <LaneToTabProvider value={{ open }}>{rows}</LaneToTabProvider> : rows,
  );
}

const clipButton = (name: RegExp) => screen.getByRole("button", { name });
const CONVERT = /^Convert audio to sheet…/;

describe("Convert audio to sheet… in the clip menu", () => {
  it("sits right after Remove silence… and asks for the clip as placed", async () => {
    const { user } = renderRows();
    fireEvent.contextMenu(clipButton(/one\.wav on Vocals/));
    const menu = await screen.findByRole("menu", { name: "Lane actions: Vocals" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent ?? "");
    const silence = names.findIndex((n) => n.startsWith("Remove silence"));
    expect(silence).toBeGreaterThan(0);
    expect(names[silence + 1]).toBe("Convert audio to sheet…");
    await expectNoA11yViolations();
    await user.click(within(menu).getByRole("menuitem", { name: CONVERT }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({
      laneId: "lane-a",
      clipIds: ["one"],
      range: { startMs: 2000, endMs: 4000 },
      origin: "clip",
    });
  });

  it("is available on a locked or muted clip", async () => {
    renderRows();
    fireEvent.contextMenu(clipButton(/one\.wav on Vocals/));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Lock" }));
    fireEvent.contextMenu(clipButton(/one\.wav on Vocals, locked/));
    const item = await screen.findByRole("menuitem", { name: CONVERT });
    expect(item).not.toHaveAttribute("aria-disabled", "true");
  });

  it("covers the union of the selected clips on the clicked lane", async () => {
    const { user } = renderRows();
    act(() => lanesNow().select(["one", "two", "hit"]));
    fireEvent.contextMenu(clipButton(/two\.wav on Vocals/));
    await user.click(await screen.findByRole("menuitem", { name: CONVERT }));
    expect(open).toHaveBeenCalledWith({
      laneId: "lane-a",
      clipIds: ["one", "two"],
      range: { startMs: 2000, endMs: 8000 },
      origin: "clip",
    });
  });

  it("keeps the right-clicked clip's lane when the selection spans lanes", async () => {
    const { user } = renderRows();
    act(() => lanesNow().select(["one", "hit"]));
    fireEvent.contextMenu(clipButton(/hit\.wav on Drums/));
    await user.click(await screen.findByRole("menuitem", { name: CONVERT }));
    expect(open).toHaveBeenCalledWith({
      laneId: "lane-b",
      clipIds: ["hit"],
      range: { startMs: 4000, endMs: 6000 },
      origin: "clip",
    });
  });

  it("is absent without the dialog context (a lane outside a workspace)", async () => {
    renderRows(song(), false);
    fireEvent.contextMenu(clipButton(/one\.wav on Vocals/));
    const menu = await screen.findByRole("menu", { name: "Lane actions: Vocals" });
    expect(within(menu).getByRole("menuitem", { name: /Remove silence/ })).toBeInTheDocument();
    expect(within(menu).queryByText(/Convert audio to sheet/)).toBeNull();
  });

  it("is absent outside the desktop app", async () => {
    setTauri(false);
    renderRows();
    fireEvent.contextMenu(clipButton(/one\.wav on Vocals/));
    const menu = await screen.findByRole("menu", { name: "Lane actions: Vocals" });
    expect(within(menu).queryByText(/Convert audio to sheet/)).toBeNull();
  });

  it("is absent on empty lane space and on a folder lane", async () => {
    renderRows();
    const lane = screen.getByTestId("lane-row-lane-b").querySelector("[data-lane-id]")!;
    // Not on a clip: the empty-space menu.
    fireEvent.contextMenu(lane, { clientX: 150 });
    const menu = await screen.findByRole("menu", { name: "Lane actions: Drums" });
    expect(within(menu).getByRole("menuitem", { name: "Paste here" })).toBeInTheDocument();
    expect(within(menu).queryByText(/Convert audio to sheet/)).toBeNull();
  });

  it("is absent on a folder lane", async () => {
    const folder = makeFolder(song(), "Folder", ["lane-b"]);
    renderRows(folder);
    const row = screen.getByTestId(`lane-row-${folder.lanes.find((l) => l.folder)!.id}`);
    fireEvent.contextMenu(row.querySelector("div[role='presentation']")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("is absent from a fade handle's own menu", async () => {
    renderRows(song(true), true, 120);
    act(() => lanesNow().select(["one"]));
    fireEvent.contextMenu(screen.getByRole("slider", { name: /^Fade in of one\.wav/ }));
    const menu = await screen.findByRole("menu", { name: "Fade in shape" });
    expect(within(menu).queryByText(/Convert audio to sheet/)).toBeNull();
    expect(screen.queryByRole("menu", { name: "Lane actions: Vocals" })).toBeNull();
  });
});

describe("Convert the selection to sheet… in the time selection's menu", () => {
  it("asks for the selection on the right-clicked lane", async () => {
    const { user } = renderRows();
    act(() => lanesNow().setTimeRange({ startMs: 1000, endMs: 3000 }));
    const lane = screen.getByTestId("lane-row-lane-b").querySelector("[data-lane-id]")!;
    fireEvent.contextMenu(lane, { clientX: 150 });
    const menu = await screen.findByRole("menu", { name: "Lane actions: Drums" });
    expect(within(menu).queryByRole("menuitem", { name: CONVERT })).toBeNull();
    await expectNoA11yViolations();
    await user.click(
      within(menu).getByRole("menuitem", { name: "Convert the selection to sheet…" }),
    );
    expect(open).toHaveBeenCalledWith({
      laneId: "lane-b",
      clipIds: [],
      range: { startMs: 1000, endMs: 3000 },
      origin: "selection",
    });
  });

  it("is absent without the dialog context", async () => {
    renderRows(song(), false);
    act(() => lanesNow().setTimeRange({ startMs: 1000, endMs: 3000 }));
    const lane = screen.getByTestId("lane-row-lane-b").querySelector("[data-lane-id]")!;
    fireEvent.contextMenu(lane, { clientX: 150 });
    const menu = await screen.findByRole("menu", { name: "Lane actions: Drums" });
    expect(within(menu).getByText(/Insert empty space/)).toBeInTheDocument();
    expect(within(menu).queryByText(/Convert the selection to sheet/)).toBeNull();
  });
});

describe("Convert audio to sheet… in the lane menu", () => {
  it("asks for the whole lane, and is absent for a folder", async () => {
    const { user } = renderRows(makeFolder(song(), "Folder", ["lane-b"]));
    await user.click(
      within(screen.getByTestId("lane-row-lane-a")).getByRole("button", {
        name: "More for Vocals",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: CONVERT }));
    expect(open).toHaveBeenCalledWith({
      laneId: "lane-a",
      clipIds: [],
      range: null,
      origin: "lane",
    });
    await user.click(screen.getByRole("button", { name: "More for Folder" }));
    await screen.findByRole("menuitem", { name: "Rename…" });
    expect(screen.queryByRole("menuitem", { name: CONVERT })).toBeNull();
  });

  it("is absent without the dialog context", async () => {
    const { user } = renderRows(song(), false);
    await user.click(
      within(screen.getByTestId("lane-row-lane-a")).getByRole("button", {
        name: "More for Vocals",
      }),
    );
    await screen.findByRole("menuitem", { name: "Rename…" });
    expect(screen.queryByRole("menuitem", { name: CONVERT })).toBeNull();
  });
});

describe("Convert audio to sheet… in the lane editor's Tasks menu", () => {
  const actions = (): LaneEditorActions => ({
    syncFromScoreTempo: vi.fn(() => []),
    tempoFromSync: vi.fn(),
    syncFromBeats: vi.fn(),
    replaceFile: vi.fn(),
    extract: vi.fn(),
    addBar: vi.fn(),
    effects: vi.fn(),
    openStudio: vi.fn(),
    close: vi.fn(),
  });
  const renderDock = (provider: boolean) => {
    const dock = (
      <Lanes audio={song()}>
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
            actions={actions()}
          />
        )}
      </Lanes>
    );
    return renderWithProviders(
      provider ? <LaneToTabProvider value={{ open }}>{dock}</LaneToTabProvider> : dock,
    );
  };

  it("asks for the whole lane", async () => {
    const { user } = renderDock(true);
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await user.click(await screen.findByRole("menuitem", { name: CONVERT }));
    expect(open).toHaveBeenCalledWith({
      laneId: "lane-a",
      clipIds: [],
      range: null,
      origin: "lane",
    });
  });

  it("is absent without the dialog context", async () => {
    const { user } = renderDock(false);
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByRole("menuitem", { name: "Clear sync points" });
    expect(screen.queryByRole("menuitem", { name: CONVERT })).toBeNull();
  });
});

describe("Convert selection to sheet… in the studio's range bar", () => {
  const xAt = (ms: number) => (ms / 1000) * 40;
  const renderStudio = (provider: boolean) => {
    const studio = (
      <Lanes audio={song()}>
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
      </Lanes>
    );
    return renderWithProviders(
      provider ? <LaneToTabProvider value={{ open }}>{studio}</LaneToTabProvider> : studio,
    );
  };
  const select = (fromMs: number, toMs: number) => {
    const ruler = screen.getByTestId("studio-ruler");
    fireEvent.pointerDown(ruler, { clientX: xAt(fromMs), pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: xAt(toMs), pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: xAt(toMs), pointerId: 1 });
  };

  it("asks for the selection on the first lane that has audio in it", async () => {
    const { user } = renderStudio(true);
    select(4000, 6000);
    await user.click(screen.getByRole("button", { name: "Convert selection to sheet…" }));
    // Vocals has no clip between 4 and 6 s; Drums does.
    expect(open).toHaveBeenCalledWith({
      laneId: "lane-b",
      clipIds: [],
      range: { startMs: 4000, endMs: 6000 },
      origin: "studio",
    });
  });

  it("is absent without the dialog context", () => {
    renderStudio(false);
    select(4000, 6000);
    expect(screen.getByRole("button", { name: "Render range" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Convert selection to sheet…" })).toBeNull();
  });
});
