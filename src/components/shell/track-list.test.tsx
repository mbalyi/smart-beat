import { fireEvent, screen, within } from "@testing-library/react";

import { TrackList, type TrackActions } from "@/components/shell/track-list";
import { mixFromScore } from "@/lib/score/mixer";
import { parseScore } from "@/lib/score/score";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes } from "@/test/score";
import { trackAction } from "@/test/track-actions";

function setup(overrides: Partial<Parameters<typeof TrackList>[0]> = {}) {
  const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
  const actions: TrackActions = {
    onShow: vi.fn(),
    onMove: vi.fn(),
    onDuplicate: vi.fn(),
    onRemove: vi.fn(),
    onSettings: vi.fn(),
    onLyrics: vi.fn(),
    onAdd: vi.fn(),
  };
  const props = {
    score,
    revision: 0,
    tracks: summary.tracks,
    shown: 0,
    mix: mixFromScore(summary),
    onChange: vi.fn(),
    onReset: vi.fn(),
    actions,
    bar: 1,
    onSeekBar: vi.fn(),
    saved: false,
    playing: false,
    ...overrides,
  };
  return { ...renderWithProviders(<TrackList {...props} />), ...props };
}

describe("TrackList", () => {
  it("lists every track with its controls, and the master row", async () => {
    setup();

    const region = screen.getByRole("region", { name: "Tracks and mixer" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(4);
    for (const name of ["Guitar", "Bass", "Drums", "Piano"]) {
      expect(within(region).getByRole("button", { name: `Show ${name}` })).toBeInTheDocument();
      expect(within(region).getByRole("button", { name: `Mute ${name}` })).toBeInTheDocument();
      expect(within(region).getByRole("button", { name: `Solo ${name}` })).toBeInTheDocument();
      expect(within(region).getByRole("slider", { name: `Volume, ${name}` })).toBeInTheDocument();
      expect(within(region).getByRole("slider", { name: `Pan, ${name}` })).toBeInTheDocument();
    }
    expect(within(region).getByRole("slider", { name: "Master volume" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("marks the shown track", () => {
    setup({ shown: 2 });

    const items = screen.getAllByRole("listitem");
    expect(items[2]).toHaveAttribute("aria-current", "true");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Show Drums" })).toHaveTextContent("(shown)");
  });

  it("shows a track from its name and its eye", async () => {
    const { user, actions } = setup();

    await user.click(screen.getByRole("button", { name: "Show Bass" }));
    await user.click(screen.getByRole("button", { name: "Visible: Drums" }));

    expect(actions.onShow).toHaveBeenNthCalledWith(1, 1);
    expect(actions.onShow).toHaveBeenNthCalledWith(2, 2);
  });

  it("mutes, solos and changes the volume", async () => {
    const { user, onChange } = setup();

    await user.click(screen.getByRole("button", { name: "Mute Bass" }));
    await user.click(screen.getByRole("button", { name: "Solo Guitar" }));
    fireEvent.keyDown(screen.getByRole("slider", { name: "Master volume" }), { key: "ArrowLeft" });

    expect(onChange).toHaveBeenCalledWith({ type: "mute", track: 1, value: true });
    expect(onChange).toHaveBeenCalledWith({ type: "solo", track: 0, value: true });
    expect(onChange).toHaveBeenCalledWith({ type: "master", value: expect.any(Number) });
  });

  it("resets the mix", async () => {
    const { user, onReset } = setup();
    await user.click(screen.getByRole("button", { name: "Reset the mix" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("runs track actions from the row menu", async () => {
    const { user, actions } = setup();

    await trackAction(user, "Bass", "Settings…");
    await trackAction(user, "Bass", "Lyrics…");
    await trackAction(user, "Bass", "Move up");
    await trackAction(user, "Bass", "Move down");
    await trackAction(user, "Bass", "Duplicate");
    await trackAction(user, "Bass", "Remove");

    expect(actions.onSettings).toHaveBeenCalledWith(1);
    expect(actions.onLyrics).toHaveBeenCalledWith(1);
    expect(actions.onMove).toHaveBeenNthCalledWith(1, 1, 0);
    expect(actions.onMove).toHaveBeenNthCalledWith(2, 1, 2);
    expect(actions.onDuplicate).toHaveBeenCalledWith(1);
    expect(actions.onRemove).toHaveBeenCalledWith(1);
  });

  it("can't move the first track up or the last one down", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: "Actions for Guitar" }));
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Actions for Piano" }));
    expect(await screen.findByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("adds a track", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("button", { name: "Add track" }));
    expect(actions.onAdd).toHaveBeenCalledOnce();
  });

  it("jumps to a bar when its cell is clicked", () => {
    const { container, onSeekBar } = setup();

    const cells = container.querySelectorAll<HTMLButtonElement>(
      "ol li:first-child button[tabindex='-1']",
    );
    expect(cells).toHaveLength(4);
    fireEvent.click(cells[2]!);

    expect(onSeekBar).toHaveBeenCalledWith(2);
  });

  it("keeps the equaliser and automation switches off until they work", () => {
    setup();
    expect(screen.getByRole("button", { name: /^Equaliser for Guitar/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Automation for Guitar/ })).toBeDisabled();
  });

  it("says whether the mix is saved and when pan waits for a pause", () => {
    const { rerender, ...rest } = setup({ saved: true, playing: true });
    expect(screen.getByText(/Mix changes are saved for this song/)).toBeInTheDocument();
    expect(screen.getByText(/Pan changes are applied when you pause/)).toBeInTheDocument();
    void rerender;
    void rest;
  });
});
