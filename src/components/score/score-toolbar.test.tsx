import { screen } from "@testing-library/react";

import { ScoreToolbar } from "@/components/score/score-toolbar";
import type { ScoreSummary } from "@/lib/score/score";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { SUMMARY } from "@/test/score";

function setup(overrides: Partial<Parameters<typeof ScoreToolbar>[0]> = {}) {
  const props = {
    name: "practice-song.gp",
    summary: SUMMARY,
    trackIndex: 0,
    view: SUMMARY.tracks[0]!.defaultView,
    layout: "page" as const,
    onOpen: vi.fn(),
    onTrackChange: vi.fn(),
    onViewChange: vi.fn(),
    onLayoutChange: vi.fn(),
    onToggleMixer: vi.fn(),
    ...overrides,
  };
  return { ...renderWithProviders(<ScoreToolbar {...props} />), props };
}

describe("ScoreToolbar", () => {
  it("shows the song and the current settings", async () => {
    setup();

    expect(screen.getByRole("heading", { level: 1, name: "Practice Song" })).toBeInTheDocument();
    expect(screen.getByText("Smart Beat")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Track" })).toHaveTextContent("Guitar");
    expect(screen.getByRole("radio", { name: "Score + tab" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Page" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Rhythm on tab" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expectNoA11yViolations();
  });

  it("falls back to the file name for songs without a title", () => {
    const untitled: ScoreSummary = { ...SUMMARY, title: "", artist: "" };
    setup({ summary: untitled });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("practice-song.gp");
  });

  it("switches tracks", async () => {
    const { user, props } = setup();

    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: "Drums" }));

    expect(props.onTrackChange).toHaveBeenCalledWith(2);
  });

  it("changes the notation and the rhythm display", async () => {
    const { user, props } = setup();

    await user.click(screen.getByRole("radio", { name: "Tab" }));
    expect(props.onViewChange).toHaveBeenLastCalledWith({ notation: "tab", rhythm: false });

    await user.click(screen.getByRole("button", { name: "Rhythm on tab" }));
    expect(props.onViewChange).toHaveBeenLastCalledWith({ notation: "score-tab", rhythm: true });
  });

  it("ignores clicks on the selected option", async () => {
    const { user, props } = setup();

    await user.click(screen.getByRole("radio", { name: "Score + tab" }));
    await user.click(screen.getByRole("radio", { name: "Page" }));

    expect(props.onViewChange).not.toHaveBeenCalled();
    expect(props.onLayoutChange).not.toHaveBeenCalled();
  });

  it("only offers standard notation for tracks without tablature", () => {
    setup({ trackIndex: 2, view: SUMMARY.tracks[2]!.defaultView });

    expect(screen.getByRole("radio", { name: "Score" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Tab" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Score + tab" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rhythm on tab" })).toBeDisabled();
  });

  it("switches between page and continuous layout", async () => {
    const { user, props } = setup();

    await user.click(screen.getByRole("radio", { name: "Continuous" }));

    expect(props.onLayoutChange).toHaveBeenCalledWith("horizontal");
  });

  it("opens files and toggles the mixer", async () => {
    const { user, props, rerender } = setup();
    const mixer = screen.getByRole("button", { name: "Mixer" });
    expect(mixer).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Open…" }));
    await user.click(mixer);
    rerender(<ScoreToolbar {...props} mixerOpen />);

    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(props.onToggleMixer).toHaveBeenCalledOnce();
    expect(mixer).toHaveAttribute("aria-expanded", "true");
  });
});
