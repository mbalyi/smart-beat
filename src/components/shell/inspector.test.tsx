import { screen, within } from "@testing-library/react";

import { Inspector, type InspectorActions, type SongInfo } from "@/components/shell/inspector";
import { DEFAULT_SOUNDFONT } from "@/lib/score/soundfonts";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { SUMMARY } from "@/test/score";

const SONG: SongInfo = {
  title: "Practice Song",
  artist: "Smart Beat",
  file: "practice-song.gp",
  bars: 4,
  tempo: 120,
  problems: 0,
};

function setup(overrides: Partial<Parameters<typeof Inspector>[0]> = {}) {
  const actions: InspectorActions = {
    onTrackSettings: vi.fn(),
    onLyrics: vi.fn(),
    onTranspose: vi.fn(),
    onFixBars: vi.fn(),
  };
  const props = {
    tab: "track" as const,
    onTabChange: vi.fn(),
    song: SONG,
    track: SUMMARY.tracks[0]!,
    view: { notation: "score-tab" as const, rhythm: false },
    onViewChange: vi.fn(),
    mix: SUMMARY.tracks[0]!.mix,
    soundFont: DEFAULT_SOUNDFONT,
    onSoundFontChange: vi.fn(),
    soundsReady: true,
    syncOffset: 0,
    onSyncOffsetChange: vi.fn(),
    actions,
    ...overrides,
  };
  return { ...renderWithProviders(<Inspector {...props} />), ...props };
}

describe("Inspector: TRACK tab", () => {
  it("lists the information, notation, sounds and interpretation of the track", async () => {
    setup();

    expect(screen.getByRole("tab", { name: "Track" })).toHaveAttribute("aria-selected", "true");
    for (const name of ["Information", "Musical notation", "Sounds", "Interpretation"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("Guitar")).toBeInTheDocument();
    expect(screen.getByText("E A D G B E")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Standard notation" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Tablature" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Instrument sounds" })).toBeEnabled();
    await expectNoA11yViolations();
  });

  it("changes the notation, keeping at least one of score and tab on", async () => {
    const { user, onViewChange } = setup();

    await user.click(screen.getByRole("switch", { name: "Tablature" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ notation: "score", rhythm: false });
  });

  it("does not turn the last notation off", async () => {
    const { user, onViewChange } = setup({ view: { notation: "tab", rhythm: false } });

    await user.click(screen.getByRole("switch", { name: "Tablature" }));

    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("disables the notation switches for tracks without tablature", () => {
    setup({ track: SUMMARY.tracks[3]!, view: { notation: "score", rhythm: false } });

    expect(screen.getByRole("switch", { name: "Standard notation" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Tablature" })).toBeDisabled();
    expect(screen.queryByText("Tuning")).not.toBeInTheDocument();
  });

  it("explains why drum tracks have no tab view", () => {
    setup({
      track: { ...SUMMARY.tracks[2]!, kind: "drums", hasTablature: false },
      view: { notation: "score", rhythm: false },
    });
    expect(screen.getByText(/Drum tracks are shown as a score/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Tablature" })).toBeDisabled();
  });

  it("opens the track settings and the lyrics", async () => {
    const { user, actions } = setup();

    await user.click(screen.getByRole("button", { name: "Track settings…" }));
    await user.click(screen.getByRole("button", { name: "Lyrics…" }));

    expect(actions.onTrackSettings).toHaveBeenCalledOnce();
    expect(actions.onLyrics).toHaveBeenCalledOnce();
  });

  it("disables the sound choice while sounds load", () => {
    setup({ soundsReady: false });
    expect(screen.getByRole("combobox", { name: "Instrument sounds" })).toBeDisabled();
  });

  it("sets the sync offset for the cursor", async () => {
    const { user, onSyncOffsetChange } = setup({ syncOffset: 20 });
    const field = screen.getByRole("spinbutton", { name: "Sync offset (ms)" });
    expect(field).toHaveValue(20);

    await user.type(field, "5");

    expect(onSyncOffsetChange).toHaveBeenLastCalledWith(205);
  });

  it("switches between SONG and TRACK", async () => {
    const { user, onTabChange } = setup();
    await user.click(screen.getByRole("tab", { name: "Song" }));
    expect(onTabChange).toHaveBeenCalledWith("song");
  });
});

describe("Inspector: SONG tab", () => {
  it("shows the song and offers its tools", async () => {
    const { user, actions } = setup({ tab: "song" });

    const info = screen.getByRole("region", { name: "Information" });
    expect(within(info).getByText("Practice Song")).toBeInTheDocument();
    expect(within(info).getByText("Smart Beat")).toBeInTheDocument();
    expect(within(info).getByText("♩ = 120")).toBeInTheDocument();
    expect(screen.queryByText(/wrong length/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Transpose…" }));
    await user.click(screen.getByRole("button", { name: "Fix bar lengths" }));
    expect(actions.onTranspose).toHaveBeenCalledOnce();
    expect(actions.onFixBars).toHaveBeenCalledOnce();
    await expectNoA11yViolations();
  });

  it("warns about bars with the wrong length", () => {
    setup({ tab: "song", song: { ...SONG, problems: 2 } });
    expect(screen.getByText(/2 bars have the wrong length/)).toBeInTheDocument();
  });

  it("falls back to the file name without a title", () => {
    setup({ tab: "song", song: { ...SONG, title: "", artist: "" } });
    expect(screen.getAllByText("practice-song.gp")).not.toHaveLength(0);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
