import { screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LaneRow } from "@/components/audio-lanes/lane-row";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { EMPTY_AUDIO, newLane } from "@/lib/audio-lanes/model";
import { makeFolder } from "@/lib/audio-lanes/edits";
import { onSamplesRequest, type SamplesRequest } from "@/lib/samples/samples-bus";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { renderWithProviders } from "@/test/render";

const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};

const song = (): AudioLanesSettings => {
  const base = { ...EMPTY_AUDIO, lanes: [newLane("Vocals", "lane-a")] };
  return makeFolder(base, "Group", []);
};

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
    epoch: null,
    songPath: null,
    grid,
  });
  return <>{children(lanes)}</>;
}

function renderRows() {
  return renderWithProviders(
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
}

const asDesktopApp = () => {
  window.__TAURI_INTERNALS__ = { invoke: vi.fn() } as never;
};

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const menuNames = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

describe("lane menu: samples", () => {
  it("offers Show samples and Import samples right after Add audio file in the desktop app", async () => {
    asDesktopApp();
    const { user } = renderRows();
    await user.click(screen.getByRole("button", { name: "More for Vocals" }));
    await screen.findByRole("menuitem", { name: "Show samples" });
    expect(menuNames().slice(0, 4)).toEqual([
      "Open the lane editor",
      "Add audio file…",
      "Show samples",
      "Import samples…",
    ]);
    expect(screen.getByRole("menuitemcheckbox", { name: "Enabled" })).toBeInTheDocument();
  });

  it("asks the song to show the samples, then to import", async () => {
    asDesktopApp();
    const requests: SamplesRequest[] = [];
    const off = onSamplesRequest((r) => requests.push(r));
    const { user } = renderRows();
    await user.click(screen.getByRole("button", { name: "More for Vocals" }));
    await user.click(await screen.findByRole("menuitem", { name: "Show samples" }));
    await user.click(screen.getByRole("button", { name: "More for Vocals" }));
    await user.click(await screen.findByRole("menuitem", { name: "Import samples…" }));
    off();
    expect(requests).toEqual(["show", "import"]);
  });

  it("leaves both out of the browser", async () => {
    const { user } = renderRows();
    await user.click(screen.getByRole("button", { name: "More for Vocals" }));
    await screen.findByRole("menuitem", { name: "Add audio file…" });
    expect(screen.queryByRole("menuitem", { name: "Show samples" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Import samples…" })).not.toBeInTheDocument();
  });

  it("leaves both out of a folder's menu", async () => {
    asDesktopApp();
    const { user } = renderRows();
    await user.click(screen.getByRole("button", { name: "More for Group" }));
    await screen.findByRole("menuitem", { name: "Rename…" });
    expect(screen.queryByRole("menuitem", { name: "Show samples" })).not.toBeInTheDocument();
  });
});
