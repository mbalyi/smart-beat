/**
 * Several songs open in tabs, as the app shows them: each workspace stays mounted and shows the
 * tab strip. Switching back to a song in edit mode continues where it was edited (#228).
 */
import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";

import { ScoreWorkspace } from "@/components/score/score-workspace";
import { DocumentTabs, type DocumentTabId } from "@/components/shell/document-tabs";
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

async function makeSong(id: number, name: string): Promise<ScoreDocument> {
  const bytes = fixtureBytes("practice-song.gp");
  const { score, summary } = parseScore(bytes);
  return {
    id,
    name,
    path: null,
    fileKey: await fileKey(bytes),
    score,
    summary,
    mix: mixFromScore(summary),
  };
}

function Songs({ songs }: { songs: ScoreDocument[] }) {
  const [activeId, setActiveId] = useState<DocumentTabId>(songs[0]!.id);
  const tabs = (
    <DocumentTabs
      tabs={songs.map((s) => ({ id: s.id, title: s.name, edited: false }))}
      activeId={activeId}
      onActivate={setActiveId}
      onClose={vi.fn()}
      onNew={vi.fn()}
    />
  );
  return (
    <div className="relative">
      {songs.map((s) => (
        <ScoreWorkspace
          key={s.id}
          song={s}
          active={s.id === activeId}
          tabs={tabs}
          onOpen={vi.fn()}
        />
      ))}
    </div>
  );
}

async function setup() {
  FakeScorePlayer.instances = [];
  const songs = [await makeSong(1, "one.gp"), await makeSong(2, "two.gp")];
  const utils = renderWithProviders(<Songs songs={songs} />);
  for (const player of FakeScorePlayer.instances) player.becomeReady();
  /** The shown song's score (hidden songs are left out of the accessibility tree). */
  const score = () => screen.getByRole("region", { name: /^Score:/ });
  /** The editor's status line: where the edit cursor is. */
  const status = () => document.getElementById(score().getAttribute("aria-describedby")!)!;
  const showTab = (name: string) => utils.user.click(screen.getByRole("button", { name }));
  return { ...utils, score, status, showTab };
}

describe("ScoreWorkspace: switching tabs", () => {
  it("puts the keyboard back at the edit cursor when a song in edit mode is shown again", async () => {
    // Arrange: edit song one and move its cursor to beat 3.
    const { user, score, status, showTab } = await setup();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(score()).toHaveFocus());
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(status()).toHaveTextContent(/^Bar 1, beat 3 of 4/);

    // Act: look at song two (not in edit mode), then come back.
    await showTab("two.gp");
    expect(screen.getByRole("button", { name: "two.gp" })).toHaveAttribute("aria-current", "true");
    expect(score()).not.toHaveFocus();
    await showTab("one.gp");

    // Assert: the score has the keyboard and the cursor is where it was left.
    await waitFor(() => expect(score()).toHaveFocus());
    expect(score()).toHaveAttribute("aria-roledescription", "score editor");
    expect(score()).toHaveAttribute("data-testid", "score-viewport");
    expect(status()).toHaveTextContent(/^Bar 1, beat 3 of 4/);
    await user.keyboard("{ArrowRight}");
    expect(status()).toHaveTextContent(/^Bar 1, beat 4 of 4/);
  });
});
