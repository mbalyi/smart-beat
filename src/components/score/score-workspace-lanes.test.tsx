import { act, fireEvent, screen, within } from "@testing-library/react";

import { ScoreWorkspace } from "@/components/score/score-workspace";
import type { ScoreDocument } from "@/hooks/use-score-document";
import { fileKey } from "@/lib/score/format";
import { addStemsToTab } from "@/lib/stems/lane-targets";
import type { StemLaneItem } from "@/lib/stems/stem-lanes";
import type { StemKindId } from "@/lib/tauri";
import { mixFromScore } from "@/lib/score/mixer";
import { parseScore } from "@/lib/score/score";
import { FakeScorePlayer } from "@/test/fake-score-player";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes } from "@/test/score";
import { mockTauri } from "@/test/tauri";

vi.mock("@/lib/score/player", async () => ({
  ScorePlayer: (await import("@/test/fake-score-player")).FakeScorePlayer,
}));

/** Clicking the bars in the track panel's lanes (#228). Tracks: Guitar, Bass, Drums, Piano. */

async function setup() {
  const bytes = fixtureBytes("practice-song.gp");
  const { score, summary } = parseScore(bytes);
  const song: ScoreDocument = {
    id: 1,
    name: "practice-song.gp",
    path: null,
    fileKey: await fileKey(bytes),
    score,
    summary,
    mix: mixFromScore(summary),
  };
  const utils = renderWithProviders(<ScoreWorkspace song={song} onOpen={vi.fn()} />);
  const player = FakeScorePlayer.last;
  player.becomeReady();
  return { ...utils, player };
}

/** Clicks a bar (0-based) in a track's lane. The cells are mouse-only, hidden from the a11y tree. */
function clickLaneBar(track: number, bar: number) {
  const region = screen.getByRole("region", { name: "Tracks and mixer" });
  const row = within(region).getAllByRole("listitem")[track]!;
  const cells = row.querySelectorAll<HTMLButtonElement>("button[tabindex='-1']");
  fireEvent.click(cells[bar]!);
}

describe("ScoreWorkspace track lanes", () => {
  it("shows another track at the bar clicked in its lane", async () => {
    const { user, player } = await setup();
    await user.click(screen.getByRole("button", { name: /^Show Drums/ }));
    expect(screen.getByRole("region", { name: "Score: Drums" })).toBeInTheDocument();
    player.showTrack.mockClear();

    clickLaneBar(0, 2);

    expect(player.showTrack).toHaveBeenCalledOnce();
    expect(player.showTrack).toHaveBeenLastCalledWith(0, expect.anything());
    expect(screen.getByRole("region", { name: "Score: Guitar" })).toBeInTheDocument();
    expect(player.seekToBar).toHaveBeenLastCalledWith(2);
    // Once the guitar is drawn, the bar is found again where it is drawn now.
    player.seekToBar.mockClear();
    player.emit("onRendered");
    expect(player.seekToBar).toHaveBeenCalledExactlyOnceWith(2);
    player.emit("onRendered");
    expect(player.seekToBar).toHaveBeenCalledOnce();
  });

  it("in Edit mode puts the cursor on the clicked bar of the opened track", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /^Show Drums/ }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("toolbar", { name: "Edit" });

    clickLaneBar(0, 2);

    const score = screen.getByRole("region", { name: "Score: Guitar" });
    const status = document.getElementById(score.getAttribute("aria-describedby")!)!;
    expect(status).toHaveTextContent(/^Bar 3, beat 1 of/);
  });

  it("only seeks for a bar of the shown track, as before", async () => {
    const { player } = await setup();

    clickLaneBar(0, 2);

    expect(player.seekToBar).toHaveBeenCalledExactlyOnceWith(2);
    expect(player.showTrack).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Score: Guitar" })).toBeInTheDocument();
    player.emit("onRendered");
    expect(player.seekToBar).toHaveBeenCalledOnce();
  });

  it("keeps the continuous view's stack and only seeks for a stacked track", async () => {
    const { user, player } = await setup();
    await user.click(screen.getByRole("radio", { name: "Continuous" }));
    await user.click(screen.getByRole("button", { name: "Visible: Drums" }));

    clickLaneBar(2, 3);

    expect(player.seekToBar).toHaveBeenCalledExactlyOnceWith(3);
    expect(player.showTrack).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Score: Guitar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Visible: Drums" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not seek again once the new track is drawn while playing", async () => {
    const { player } = await setup();
    player.emit("onPlayingChange", true);
    player.isPlaying.mockReturnValue(true);

    clickLaneBar(1, 3);

    expect(screen.getByRole("region", { name: "Score: Bass" })).toBeInTheDocument();
    expect(player.seekToBar).toHaveBeenCalledExactlyOnceWith(3);
    player.emit("onRendered");
    expect(player.seekToBar).toHaveBeenCalledOnce();
  });
});

/** Stems added from the stem page become audio lanes of the open tab (#223). */
describe("ScoreWorkspace stems as audio lanes", () => {
  const stems = (...kinds: StemKindId[]): StemLaneItem[] =>
    kinds.map((kind) => ({
      kind,
      info: {
        id: kind.padEnd(64, "0"),
        name: `${kind} - Song.wav`,
        ext: "wav",
        durationMs: 10_000,
        sampleRate: 44_100,
        channels: 2,
        peaks: [0.4, 0.2],
        peaksPerSecond: 20,
      },
    }));

  async function open() {
    // Audio lanes are listed in the desktop app only.
    mockTauri();
    const bytes = fixtureBytes("practice-song.gp");
    const { score, summary } = parseScore(bytes);
    const song: ScoreDocument = {
      id: 41,
      name: "practice-song.gp",
      path: null,
      fileKey: await fileKey(bytes),
      score,
      summary,
      mix: mixFromScore(summary),
    };
    const onEditedChange = vi.fn();
    const utils = renderWithProviders(
      <ScoreWorkspace song={song} onOpen={vi.fn()} onEditedChange={onEditedChange} />,
    );
    FakeScorePlayer.last.becomeReady();
    return {
      ...utils,
      onEditedChange,
      tracks: () => screen.getByRole("region", { name: "Tracks and mixer" }),
    };
  }

  it("adds a lane per stem named after the stem and the model, and marks the tab unsaved", async () => {
    const { tracks, onEditedChange } = await open();
    expect(
      within(tracks()).queryByRole("button", { name: "Mute the lane Drums · HTDemucs" }),
    ).toBeNull();
    onEditedChange.mockClear();

    act(() => addStemsToTab(41, { engine: "htdemucs" }, stems("drums", "vocals")));

    expect(
      await within(tracks()).findByRole("button", { name: "Mute the lane Drums · HTDemucs" }),
    ).toBeInTheDocument();
    expect(
      within(tracks()).getByRole("button", { name: "Mute the lane Vocals · HTDemucs" }),
    ).toBeInTheDocument();
    expect(onEditedChange).toHaveBeenCalledWith(true);
    // The song's own tracks are all still there.
    for (const name of ["Guitar", "Bass", "Drums", "Piano"]) {
      expect(within(tracks()).getAllByText(new RegExp(`^${name}`)).length).toBeGreaterThan(0);
    }
  });

  it("refuses stems that do not fit and changes nothing", async () => {
    const { tracks, onEditedChange } = await open();
    act(() =>
      addStemsToTab(41, { engine: "fast" }, stems("drums", "bass", "vocals", "panned", "other")),
    );
    expect(
      await within(tracks()).findByRole("button", {
        name: "Mute the lane Other (not separated) · Fast",
      }),
    ).toBeInTheDocument();
    onEditedChange.mockClear();
    // 16 lanes fit; fill the rest, then one more is too many.
    for (let i = 0; i < 11; i += 1) {
      act(() => addStemsToTab(41, { engine: "scnet" }, [stems("bass")[0]!]));
    }
    expect(() => addStemsToTab(41, { engine: "scnet" }, stems("drums", "bass"))).toThrow(
      /no room|already has the most/,
    );
    expect(onEditedChange).toHaveBeenCalledTimes(11);
  });

  it("is not a target any more once the tab is closed", async () => {
    const { unmount } = await open();
    unmount();
    expect(() => addStemsToTab(41, { engine: "fast" }, stems("bass"))).toThrow("not open any more");
  });
});
