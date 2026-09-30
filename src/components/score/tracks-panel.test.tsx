import { screen, within } from "@testing-library/react";

import { TracksPanel, type TrackActions } from "@/components/score/tracks-panel";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { SUMMARY } from "@/test/score";

function setup(tracks = SUMMARY.tracks) {
  const actions: TrackActions = {
    onShow: vi.fn(),
    onMove: vi.fn(),
    onDuplicate: vi.fn(),
    onRemove: vi.fn(),
    onSettings: vi.fn(),
    onLyrics: vi.fn(),
    onAdd: vi.fn(),
  };
  const utils = renderWithProviders(
    <TracksPanel open onOpenChange={vi.fn()} tracks={tracks} shown={1} actions={actions} />,
  );
  return { ...utils, actions };
}

const item = (name: RegExp) => screen.getByRole("heading", { name }).closest("li")!;

describe("TracksPanel", () => {
  it("lists the tracks with their instruments", async () => {
    setup();

    const panel = screen.getByRole("dialog", { name: "Tracks" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
    expect(item(/1\. Guitar/)).toHaveTextContent("Overdriven Guitar · Guitar Standard Tuning");
    expect(item(/2\. Bass/)).toHaveTextContent("(shown)");
    expect(item(/3\. Drums/)).toHaveTextContent("Drums");
    await expectNoA11yViolations();
  });

  it("shows, moves, duplicates, removes and opens the settings of tracks", async () => {
    const { user, actions } = setup();

    await user.click(within(item(/1\. Guitar/)).getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Move Bass up" }));
    await user.click(screen.getByRole("button", { name: "Move Bass down" }));
    await user.click(screen.getByRole("button", { name: "Duplicate Drums" }));
    await user.click(screen.getByRole("button", { name: "Remove Piano" }));
    await user.click(screen.getByRole("button", { name: "Settings… for Guitar" }));
    await user.click(screen.getByRole("button", { name: "Add track…" }));

    expect(actions.onShow).toHaveBeenCalledWith(0);
    expect(vi.mocked(actions.onMove).mock.calls).toEqual([
      [1, 0],
      [1, 2],
    ]);
    expect(actions.onDuplicate).toHaveBeenCalledWith(2);
    expect(actions.onRemove).toHaveBeenCalledWith(3);
    expect(actions.onSettings).toHaveBeenCalledWith(0);
    expect(actions.onAdd).toHaveBeenCalledOnce();
  });

  it("opens a track's lyrics", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("button", { name: "Lyrics… for Piano" }));
    expect(actions.onLyrics).toHaveBeenCalledWith(3);
  });

  it("disables what can't be done", () => {
    setup();
    expect(within(item(/2\. Bass/)).getByRole("button", { name: "Show" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Guitar up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Piano down" })).toBeDisabled();
  });

  it("keeps the last track", () => {
    setup([SUMMARY.tracks[0]!]);
    expect(screen.getByRole("button", { name: "Remove Guitar" })).toBeDisabled();
  });
});
