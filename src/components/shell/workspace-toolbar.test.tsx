import { screen } from "@testing-library/react";

import { TogetherButton } from "@/components/practice-together/sync-quality";
import { WorkspaceToolbar } from "@/components/shell/workspace-toolbar";
import { parseScore } from "@/lib/score/score";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes } from "@/test/score";

const { summary } = parseScore(fixtureBytes("practice-song.gp"));

function renderToolbar(over: Partial<Parameters<typeof WorkspaceToolbar>[0]> = {}) {
  const handlers = {
    onPlayPause: vi.fn(),
    onStop: vi.fn(),
    onSeekBar: vi.fn(),
  };
  const utils = renderWithProviders(
    <WorkspaceToolbar
      title="Song"
      summary={summary}
      trackIndex={0}
      onTrackChange={vi.fn()}
      view={{ notation: "score-tab", rhythm: false }}
      onViewChange={vi.fn()}
      layout="page"
      onLayoutChange={vi.fn()}
      zoom={100}
      onZoomChange={vi.fn()}
      onOpen={vi.fn()}
      editing={false}
      onToggleEditing={vi.fn()}
      edited={false}
      undoLabel={null}
      redoLabel={null}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      ready
      playing={false}
      position={{ currentMs: 0, endMs: 1000, bpm: 120 }}
      bar={2}
      barCount={8}
      {...handlers}
      instrumentView={false}
      instrumentLabel="Fretboard"
      onToggleInstrumentView={vi.fn()}
      inspectorOpen={false}
      onToggleInspector={vi.fn()}
      mixerOpen={false}
      onToggleMixer={vi.fn()}
      practiceView={false}
      onTogglePracticeView={vi.fn()}
      {...over}
    />,
  );
  return { ...utils, ...handlers };
}

const TRANSPORT = ["First bar", "Previous bar", "Play", "Stop", "Next bar", "Last bar"];

describe("WorkspaceToolbar: Practice together (#158)", () => {
  it("lets the transport work as usual", async () => {
    const { user, onPlayPause, onStop, onSeekBar } = renderToolbar();
    for (const name of TRANSPORT) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    await user.click(screen.getByRole("button", { name: "Play" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Next bar" }));
    expect(onPlayPause).toHaveBeenCalled();
    expect(onStop).toHaveBeenCalled();
    expect(onSeekBar).toHaveBeenCalledWith(3);
  });

  it("has a Practice together button beside Record to Tab before a session starts", async () => {
    const onOpen = vi.fn();
    const { user } = renderToolbar({
      record: <button type="button">Record to Tab</button>,
      together: <TogetherButton state={null} onOpen={onOpen} />,
    });
    const buttons = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons.indexOf("Practice together")).toBe(buttons.indexOf("Record to Tab") + 1);
    await user.click(screen.getByRole("button", { name: "Practice together" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows the session chip it is given", () => {
    renderToolbar({ together: <button type="button">Chip here</button> });
    expect(screen.getByRole("button", { name: "Chip here" })).toBeInTheDocument();
  });
});
