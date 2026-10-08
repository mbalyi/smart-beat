import { fireEvent, screen, within } from "@testing-library/react";

import { TrackList, type TrackActions } from "@/components/shell/track-list";
import { shortText } from "@/lib/score/tempo";
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

  it("warns next to a track whose lowest string is far below its sound (#43)", async () => {
    const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
    // The guitar becomes an 8-string overdriven guitar: F#1 is below what it was recorded at.
    const tracks = summary.tracks.map((t, i) =>
      i === 0 ? { ...t, program: 29, tuning: [64, 59, 55, 50, 45, 40, 35, 30] } : t,
    );
    renderWithProviders(
      <TrackList
        score={score}
        revision={0}
        tracks={tracks}
        shown={0}
        mix={mixFromScore(summary)}
        onChange={vi.fn()}
        onReset={vi.fn()}
        actions={
          {
            onShow: vi.fn(),
            onMove: vi.fn(),
            onDuplicate: vi.fn(),
            onRemove: vi.fn(),
            onSettings: vi.fn(),
            onLyrics: vi.fn(),
            onAdd: vi.fn(),
          } as TrackActions
        }
        bar={1}
        onSeekBar={vi.fn()}
        saved={false}
        playing={false}
        soundFont="sonivox"
      />,
    );
    const marks = screen.getAllByTestId("low-sound-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAccessibleName(/^Guitar: The lowest string \(F#1\)/);
    await expectNoA11yViolations();
  });

  it("shows no warning for ordinary tunings or without a sound set", () => {
    setup({ soundFont: "sonivox" });
    expect(screen.queryByTestId("low-sound-mark")).not.toBeInTheDocument();
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

  it("marks the tempo changes above the bar grid", () => {
    setup();
    const markers = screen.getByTestId("tempo-markers");
    expect(markers).toHaveTextContent("♩60");
    expect(markers).toHaveTextContent("♩120");
  });

  it("shows the texts of the bars above all the tracks", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    score.tracks[1]!.staves[0]!.bars[2]!.voices[0]!.beats[0]!.text = "Valami";
    setup({ score });
    const texts = screen.getByTestId("bar-texts");
    expect(texts).toHaveTextContent("Valami");
    expect(within(texts).getByTitle("Bar 3: Valami")).toBeInTheDocument();
  });

  it("shortens long texts to a few words", () => {
    expect(shortText("one two three")).toBe("one two three");
    expect(shortText("a b c d e f g h")).toBe("a b c d e f…");
  });

  it("has no text row without texts", () => {
    setup();
    expect(screen.queryByTestId("bar-texts")).not.toBeInTheDocument();
  });

  it("switches automation on", async () => {
    const onChange = vi.fn();
    const { user } = setup({ onChange });
    await user.click(screen.getByRole("button", { name: "Automation for Guitar" }));
    expect(onChange).toHaveBeenCalledWith({
      type: "automation",
      track: 0,
      automation: { enabled: true, volume: [], pan: [], mute: [] },
    });
  });

  it("edits the automation lane under the track", async () => {
    const onChange = vi.fn();
    const { summary } = parseScore(fixtureBytes("practice-song.gp"));
    const on = {
      ...mixFromScore(summary),
      automation: [{ enabled: true, volume: [{ bar: 1, value: 0.5 }], pan: [], mute: [] }],
    };
    const { user, container } = setup({ mix: on, onChange });
    const lane = within(container).getByRole("group", { name: "Volume automation, Guitar" });
    const point = within(lane).getByRole("slider", { name: "Volume point at bar 2" });
    expect(point).toHaveAttribute("aria-valuetext", "50%");
    point.focus();
    await user.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith({
      type: "automation",
      track: 0,
      automation: expect.objectContaining({ volume: [{ bar: 1, value: 0.55 }] }),
    });
    await user.keyboard("{Delete}");
    expect(onChange).toHaveBeenLastCalledWith({
      type: "automation",
      track: 0,
      automation: expect.objectContaining({ volume: [] }),
    });
    await user.click(within(container).getByRole("combobox", { name: "Automation lane, Guitar" }));
    await user.click(screen.getByRole("option", { name: "Mute" }));
    expect(
      within(container).getByRole("group", { name: "Mute automation, Guitar" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("edits a track's channel EQ in a popover", async () => {
    const onChange = vi.fn();
    const { user } = setup({ onChange });
    await user.click(screen.getByRole("button", { name: "EQ for Bass" }));
    const low = await screen.findByRole("slider", { name: "EQ low, Bass" });
    low.focus();
    await user.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith({
      type: "eq",
      track: 1,
      eq: { lowDb: 0.5, midDb: 0, midHz: 1000, highDb: 0 },
    });
    await user.click(screen.getByRole("switch", { name: "10-band EQ, Bass" }));
    expect(onChange).toHaveBeenLastCalledWith({
      type: "eq",
      track: 1,
      eq: expect.objectContaining({ graphic: Array(10).fill(0) }),
    });
  });

  it("opens the pedalboard, the drum mixer and the focus from the row menu", async () => {
    const onChange = vi.fn();
    const onEffects = vi.fn();
    const onDrumMixer = vi.fn();
    const actions: TrackActions = {
      onShow: vi.fn(),
      onMove: vi.fn(),
      onDuplicate: vi.fn(),
      onRemove: vi.fn(),
      onSettings: vi.fn(),
      onLyrics: vi.fn(),
      onAdd: vi.fn(),
      onEffects,
      onDrumMixer,
    };
    const { user: u2 } = setup({ onChange, actions });
    await trackAction(u2, "Drums", "Drum mixer…");
    expect(onDrumMixer).toHaveBeenCalledWith(2);
    await trackAction(u2, "Guitar", "Effects (pedalboard)…");
    expect(onEffects).toHaveBeenCalledWith(0);
    await trackAction(u2, "Bass", "Focus (turn the others down)");
    expect(onChange).toHaveBeenCalledWith({ type: "focus", track: 1 });
  });

  it("has a master strip with pan, a meter and the mastering effects", async () => {
    const onChange = vi.fn();
    const onMasterEffects = vi.fn();
    const { user } = setup({ onChange, onMasterEffects });
    await user.click(screen.getByRole("button", { name: "Mastering effects" }));
    expect(onMasterEffects).toHaveBeenCalled();
    const pan = screen.getByRole("slider", { name: "Master pan" });
    pan.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith({ type: "master-pan", value: -0.125 });
    expect(screen.getByRole("meter", { name: "Level, master" })).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Level, Guitar" })).toBeInTheDocument();
  });

  it("disables the mastering effects where effects cannot be edited", () => {
    setup();
    expect(screen.getByRole("button", { name: "Mastering effects" })).toBeDisabled();
  });

  it("adds an audio track, then mixes it like a track", async () => {
    const onChange = vi.fn();
    const onAdd = vi.fn();
    const onEdit = vi.fn();
    const audio = { info: null, barTimes: [0, 2000, 4000], onAdd, onEdit };
    const first = setup({ onChange, audio });
    await first.user.click(screen.getByRole("button", { name: "Add audio track" }));
    expect(onAdd).toHaveBeenCalled();
    first.unmount();
    const mix = first.mix;
    const audioTrack = {
      name: "take.mp3",
      path: "/take.mp3",
      embedded: false,
      enabled: true,
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      eq: { lowDb: 0, midDb: 0, midHz: 1000, highDb: 0 },
      semitones: 0,
      cents: 0,
      filter: "off" as const,
      sync: [],
    };
    const { user, container } = setup({ onChange, audio, mix: { ...mix, audioTrack } });
    const row = within(container).getByTestId("audio-track-row");
    expect(within(row).getByText("Recording not loaded")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Mute the audio track" }));
    expect(onChange).toHaveBeenLastCalledWith({
      type: "audio-track",
      value: { ...audioTrack, mute: true },
    });
    await user.click(within(row).getByRole("button", { name: "Edit the audio track take.mp3" }));
    expect(onEdit).toHaveBeenCalled();
    expect(within(container).queryByRole("button", { name: "Add audio track" })).toBeNull();
  });

  it("says whether the mix is saved and when pan waits for a pause", () => {
    const { rerender, ...rest } = setup({ saved: true, playing: true });
    expect(screen.getByText(/Mix changes are saved for this song/)).toBeInTheDocument();
    expect(screen.getByText(/Pan changes are applied when you pause/)).toBeInTheDocument();
    void rerender;
    void rest;
  });
});
