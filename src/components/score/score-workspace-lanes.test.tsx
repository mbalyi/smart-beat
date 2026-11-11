import { fireEvent, screen, within } from "@testing-library/react";

import { ScoreWorkspace } from "@/components/score/score-workspace";
import type { ScoreDocument } from "@/hooks/use-score-document";
import { fileKey } from "@/lib/score/format";
import { mixFromScore } from "@/lib/score/mixer";
import { parseScore } from "@/lib/score/score";
import { FakeScorePlayer } from "@/test/fake-score-player";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes } from "@/test/score";

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
