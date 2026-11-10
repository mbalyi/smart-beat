import { act, screen, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  MultiClipProperties,
  SelectedClipsPanel,
} from "@/components/audio-lanes/multi-clip-properties";
import { StudioView } from "@/components/audio-lanes/studio-view";
import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { findClip } from "@/lib/audio-lanes/edits";
import { EMPTY_AUDIO, MAX_SEMITONES, newClip, newLane } from "@/lib/audio-lanes/model";
import { selectedClips } from "@/lib/audio-lanes/multi-edit";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioClip, AudioLanesSettings, MixerSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const SOURCE = { id: "a".repeat(64), name: "take.wav", ext: "wav", embedded: true };
const IDS = ["clip-a", "clip-b", "clip-c"];

function clip(id: string, startMs: number, patch: Partial<AudioClip> = {}): AudioClip {
  return { ...newClip(SOURCE.id, `${id}.wav`, startMs, 1000, id), ...patch };
}

function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [
          clip("clip-a", 0, { gainDb: -6, semitones: 20, mute: true }),
          clip("clip-b", 2000, { gainDb: 2, semitones: 0, fadeIn: { ms: 40, shape: "sCurve" } }),
        ],
      },
      { ...newLane("Drums", "lane-b"), clips: [clip("clip-c", 0, { gainDb: -6 })] },
    ],
  };
}

const latest: { lanes: AudioLanesController | null } = { lanes: null };
const lanesNow = () => latest.lanes!;
const clipNow = (id: string) => findClip(lanesNow().audio, id)!.clip;

/** Runs the real lanes hook over a mix, with `selection` selected, and hands it to `children`. */
function Lanes({
  children,
  selection = IDS,
}: {
  children: (lanes: AudioLanesController) => ReactNode;
  selection?: readonly string[];
}) {
  const [mix, setMix] = useState<MixerSettings>({
    version: 3,
    master: 1,
    tracks: [],
    audio: song(),
  });
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
  const { select } = lanes;
  const selected = selection.join(",");
  useEffect(() => select(selected ? selected.split(",") : []), [select, selected]);
  useEffect(() => {
    latest.lanes = lanes;
  });
  return <>{children(lanes)}</>;
}

const renderMulti = () =>
  renderWithProviders(
    <Lanes>
      {(lanes) => (
        <MultiClipProperties lanes={lanes} clips={selectedClips(lanes.audio, lanes.selection)} />
      )}
    </Lanes>,
  );

describe("MultiClipProperties", () => {
  it("shows how many clips are selected and marks the fields they differ in as mixed", async () => {
    renderMulti();
    const panel = await screen.findByRole("complementary", { name: "Clip properties" });
    expect(within(panel).getByRole("heading", { name: "3 clips" })).toBeInTheDocument();
    const gain = within(panel).getByRole("spinbutton", { name: "Gain" });
    expect(gain).toHaveValue(null);
    expect(gain).toHaveAttribute("placeholder", "Mixed");
    expect(gain).toHaveAccessibleDescription(/different values/);
    // Every clip has the same cents and playrate: those show their value.
    expect(within(panel).getByRole("spinbutton", { name: "Cents" })).toHaveValue(0);
    expect(within(panel).getByRole("spinbutton", { name: "Playrate" })).toHaveValue(1);
    expect(within(panel).getByRole("button", { name: "Mute" })).toHaveAttribute(
      "aria-pressed",
      "mixed",
    );
    expect(within(panel).getByRole("button", { name: "Lock" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const curve = within(panel).getByRole("combobox", { name: "Fade in curve" });
    expect(curve).toHaveDisplayValue("Mixed");
    expect(curve).toHaveAccessibleDescription(/different values/);
    await expectNoA11yViolations();
  });

  it("sets a typed gain on every clip as one undo step", async () => {
    const { user } = renderMulti();
    const gain = await screen.findByRole("spinbutton", { name: "Gain" });
    await user.type(gain, "-3{Enter}");
    expect(IDS.map((id) => clipNow(id).gainDb)).toEqual([-3, -3, -3]);
    expect(gain).toHaveValue(-3);
    expect(screen.getByRole("status")).toHaveTextContent("Gain set to -3 on 3 clips");
    act(() => void lanesNow().undo());
    expect(IDS.map((id) => clipNow(id).gainDb)).toEqual([-6, 2, -6]);
    expect(lanesNow().canUndo).toBe(false);
  });

  it("adds a relative pitch change to each clip's own value, clamped to the limit", async () => {
    const { user } = renderMulti();
    await user.click(await screen.findByRole("radio", { name: "Relative" }));
    const semitones = screen.getByRole("spinbutton", { name: "Semitones change" });
    expect(semitones).toHaveAttribute("placeholder", "+0");
    expect(semitones).toHaveAccessibleDescription(/each clip's own value/);
    await user.type(semitones, "7");
    await user.tab();
    expect(IDS.map((id) => clipNow(id).semitones)).toEqual([MAX_SEMITONES, 7, 7]);
    // The field is ready for the next change.
    expect(semitones).toHaveValue(null);
  });

  it("switches a mixed toggle on for every clip, then off", async () => {
    const { user } = renderMulti();
    const mute = await screen.findByRole("button", { name: "Mute" });
    await user.click(mute);
    expect(IDS.map((id) => clipNow(id).mute)).toEqual([true, true, true]);
    expect(mute).toHaveAttribute("aria-pressed", "true");
    await user.click(mute);
    expect(IDS.map((id) => clipNow(id).mute)).toEqual([false, false, false]);
  });

  it("sets a fade curve and length on every clip", async () => {
    const { user } = renderMulti();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Fade in curve" }),
      "Equal power",
    );
    expect(IDS.map((id) => clipNow(id).fadeIn.shape)).toEqual([
      "equalPower",
      "equalPower",
      "equalPower",
    ]);
    expect(clipNow("clip-b").fadeIn.ms).toBe(40);
    await user.type(screen.getByRole("spinbutton", { name: "Fade out" }), "{Backspace}25{Enter}");
    expect(IDS.map((id) => clipNow(id).fadeOut.ms)).toEqual([25, 25, 25]);
  });

  it("leaves single-clip settings out and says how to reach them", async () => {
    renderMulti();
    await screen.findByRole("heading", { name: "3 clips" });
    expect(screen.queryByRole("button", { name: "Add gain point" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Take" })).not.toBeInTheDocument();
    expect(screen.getByText(/Select one clip to edit its name, takes/)).toBeInTheDocument();
    // No file is loaded, so there are no peaks to normalize to.
    expect(screen.getByRole("button", { name: "Normalize each clip" })).toBeDisabled();
  });
});

describe("SelectedClipsPanel", () => {
  it("shows one clip's full settings, or the shared settings of several", async () => {
    const { rerender } = renderWithProviders(
      <Lanes selection={["clip-b"]}>{(lanes) => <SelectedClipsPanel lanes={lanes} />}</Lanes>,
    );
    expect(await screen.findByTestId("clip-properties")).toBeInTheDocument();
    rerender(<Lanes selection={IDS}>{(lanes) => <SelectedClipsPanel lanes={lanes} />}</Lanes>);
    expect(await screen.findByTestId("multi-clip-properties")).toBeInTheDocument();
  });

  it("shows nothing with no clip selected", () => {
    renderWithProviders(
      <Lanes selection={[]}>{(lanes) => <SelectedClipsPanel lanes={lanes} />}</Lanes>,
    );
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

describe("StudioView properties", () => {
  const renderStudio = () =>
    renderWithProviders(
      <Lanes selection={[]}>
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

  it("opens the panel for the selected clips with F2 and moves the focus to it", async () => {
    const { user } = renderStudio();
    await user.click(screen.getByRole("button", { name: /clip-a\.wav on Vocals/ }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /clip-c\.wav on Drums/ }));
    await user.keyboard("{/Shift}{F2}");
    const panel = await screen.findByTestId("multi-clip-properties");
    expect(within(panel).getByRole("heading", { name: "2 clips" })).toBeInTheDocument();
    expect(panel).toHaveFocus();
  });

  it("opens and focuses one clip's panel on a double-click", async () => {
    const { user } = renderStudio();
    await user.dblClick(screen.getByRole("button", { name: /clip-b\.wav on Vocals/ }));
    expect(await screen.findByTestId("clip-properties")).toHaveFocus();
  });
});
