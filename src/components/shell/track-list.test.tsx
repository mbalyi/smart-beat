import { model } from "@coderline/alphatab";
import { fireEvent, screen, within } from "@testing-library/react";

import { NOTES_STORAGE_KEY, TrackList, type TrackActions } from "@/components/shell/track-list";
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

  it("hides and shows the sections, tempo markers and texts with the eye toggle", () => {
    localStorage.removeItem(NOTES_STORAGE_KEY);
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    score.tracks[1]!.staves[0]!.bars[2]!.voices[0]!.beats[0]!.text = "Valami";
    score.masterBars[2]!.section = Object.assign(new model.Section(), {
      marker: "",
      text: "Verse",
    });
    setup({ score });
    const eye = screen.getByRole("button", {
      name: "Show sections, tempo markers and texts",
    });
    expect(eye).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("tempo-markers")).toBeInTheDocument();

    fireEvent.click(eye);
    expect(eye).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("tempo-markers")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bar-texts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bar-sections")).not.toBeInTheDocument();
    expect(localStorage.getItem(NOTES_STORAGE_KEY)).toBe("hidden");

    fireEvent.click(eye);
    expect(eye).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("tempo-markers")).toBeInTheDocument();
    expect(screen.getByTestId("bar-texts")).toBeInTheDocument();
    expect(screen.getByTestId("bar-sections")).toBeInTheDocument();
    localStorage.removeItem(NOTES_STORAGE_KEY);
  });

  it("remembers that the rows above the bars were hidden", () => {
    localStorage.setItem(NOTES_STORAGE_KEY, "hidden");
    setup();
    expect(screen.queryByTestId("tempo-markers")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show sections, tempo markers and texts" }),
    ).toHaveAttribute("aria-pressed", "false");
    localStorage.removeItem(NOTES_STORAGE_KEY);
  });

  it("shows the texts of the bars above all the tracks", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    score.tracks[1]!.staves[0]!.bars[2]!.voices[0]!.beats[0]!.text = "Valami";
    setup({ score });
    const texts = screen.getByTestId("bar-texts");
    expect(texts).toHaveTextContent("Valami");
    expect(within(texts).getByTitle("Bar 3: Valami")).toBeInTheDocument();
  });

  it("shows the section names above the bars they start in (#178)", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    score.masterBars[2]!.section = Object.assign(new model.Section(), {
      marker: "",
      text: "Verse 1",
    });
    setup({ score });
    const sections = screen.getByTestId("bar-sections");
    expect(sections).toHaveTextContent("Verse 1");
    expect(within(sections).getByTitle("Bar 3: Verse 1")).toBeInTheDocument();
  });

  it("scrolls along with the playing bar, unless the user scrolled by hand (#178)", () => {
    const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
    const props = { score, tracks: summary.tracks, mix: mixFromScore(summary) };
    const { rerender, ...rest } = setup({ ...props, bar: 0, playing: true });
    const region = screen.getByRole("region", { name: "Tracks and mixer" });
    Object.defineProperty(region, "clientWidth", { value: 800, configurable: true });
    const again = (bar: number) => rerender(<TrackList {...rest} {...props} bar={bar} playing />);

    again(100);
    expect(region.scrollLeft).toBeGreaterThan(0);

    region.scrollLeft = 0;
    fireEvent.wheel(region);
    again(101); // playback goes on: the user's scroll is left alone
    expect(region.scrollLeft).toBe(0);
    again(200); // a seek from the toolbar or the score: following resumes
    expect(region.scrollLeft).toBeGreaterThan(0);
  });

  it("scrolls back to the first bar when playback stops at the start (#182)", () => {
    const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
    const props = { score, tracks: summary.tracks, mix: mixFromScore(summary) };
    const { rerender, ...rest } = setup({ ...props, bar: 0, playing: true });
    const region = screen.getByRole("region", { name: "Tracks and mixer" });
    Object.defineProperty(region, "clientWidth", { value: 800, configurable: true });
    rerender(<TrackList {...rest} {...props} bar={100} playing />);
    expect(region.scrollLeft).toBeGreaterThan(0);

    rerender(<TrackList {...rest} {...props} bar={100} playing={false} />); // Pause stays
    expect(region.scrollLeft).toBeGreaterThan(0);
    rerender(<TrackList {...rest} {...props} bar={0} playing={false} />); // Stop
    expect(region.scrollLeft).toBe(0);
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
    const low = await screen.findByRole("slider", { name: "Bass, EQ low" });
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

  it("colours a track's strip and bars, and picks another colour from the row menu (#83)", async () => {
    const onChange = vi.fn();
    const { summary } = parseScore(fixtureBytes("practice-song.gp"));
    const mix = { ...mixFromScore(summary), trackColors: [null, "#3e63dd", null, null] };
    const { user, container } = setup({ onChange, mix });
    const strips = container.querySelectorAll("li span.h-5.w-1");
    expect((strips[0] as HTMLElement).style.backgroundColor).toContain("var(--track-1)");
    expect((strips[1] as HTMLElement).style.backgroundColor).toContain("oklch(clamp(");
    await user.click(screen.getByRole("button", { name: "Actions for Bass" }));
    await user.click(screen.getByRole("menuitem", { name: "Colour…" }));
    const dialog = await screen.findByRole("dialog", { name: "Track colour: Bass" });
    await user.click(within(dialog).getByRole("button", { name: "Red" }));
    expect(onChange).toHaveBeenLastCalledWith({ type: "track-color", track: 1, color: "#e5484d" });
    await user.click(within(dialog).getByRole("button", { name: "Reset all colours" }));
    expect(onChange).toHaveBeenLastCalledWith({ type: "reset-track-colors" });
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

  it("normalizes drums only from a drum track and copies other tracks to an instrument (#134, #135)", async () => {
    const onNormalizeDrums = vi.fn();
    const onCopyToInstrument = vi.fn();
    const actions: TrackActions = {
      onShow: vi.fn(),
      onMove: vi.fn(),
      onDuplicate: vi.fn(),
      onRemove: vi.fn(),
      onSettings: vi.fn(),
      onLyrics: vi.fn(),
      onAdd: vi.fn(),
      onNormalizeDrums,
      onCopyToInstrument,
    };
    const { user } = setup({ actions });
    await trackAction(user, "Drums", "Normalize drum notation");
    expect(onNormalizeDrums).toHaveBeenCalledWith(2);
    await trackAction(user, "Guitar", "Copy to instrument…");
    expect(onCopyToInstrument).toHaveBeenCalledWith(0);

    await user.click(screen.getByRole("button", { name: "Actions for Guitar" }));
    expect(
      screen.queryByRole("menuitem", { name: "Normalize drum notation" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Actions for Drums" }));
    expect(screen.queryByRole("menuitem", { name: "Copy to instrument…" })).not.toBeInTheDocument();
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
    expect(onChange).toHaveBeenLastCalledWith({ type: "master-pan", value: -0.01 });
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

  describe("monitor track", () => {
    const baseMix = () => mixFromScore(parseScore(fixtureBytes("practice-song.gp")).summary);
    const monitorTrack = {
      enabled: true,
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      eq: { lowDb: 0, midDb: 0, midHz: 1000, highDb: 0 },
      effects: [],
    };
    const opened = {
      open: true,
      device: "Scarlett 2i2 USB",
      channels: 2,
      sampleRate: 48_000,
      latencyMs: 8.6,
      error: null,
    };
    const monitorProps = (over: object = {}) => ({
      status: opened,
      engineOn: true,
      inputName: "Scarlett 2i2 USB",
      channel: 0,
      onAdd: vi.fn(),
      onRemove: vi.fn(),
      onEffects: vi.fn(),
      onInputSettings: vi.fn(),
      ...over,
    });

    it("is added from the header", async () => {
      const monitor = monitorProps();
      const { user } = setup({ monitor });
      await user.click(screen.getByRole("button", { name: "Add monitor track" }));
      expect(monitor.onAdd).toHaveBeenCalled();
      expect(screen.queryByTestId("monitor-track-row")).toBeNull();
    });

    it("is mixed like a track and shows what it listens to", async () => {
      const onChange = vi.fn();
      const monitor = monitorProps();
      const base = baseMix();
      const { user, container } = setup({
        onChange,
        monitor,
        mix: { ...base, monitor: monitorTrack },
      });
      const row = within(container).getByTestId("monitor-track-row");
      expect(within(container).queryByRole("button", { name: "Add monitor track" })).toBeNull();
      expect(within(row).getByRole("status")).toHaveTextContent(
        "Scarlett 2i2 USB · input 1 · about 9 ms delay",
      );
      expect(within(row).getByRole("meter", { name: "Input level, monitor track" })).toBeVisible();

      await user.click(within(row).getByRole("button", { name: "Mute the monitor track" }));
      expect(onChange).toHaveBeenLastCalledWith({
        type: "monitor",
        value: { ...monitorTrack, mute: true },
      });
      await user.click(within(row).getByRole("button", { name: "Solo the monitor track" }));
      expect(onChange).toHaveBeenLastCalledWith({
        type: "monitor",
        value: { ...monitorTrack, solo: true },
      });
      await user.click(
        within(row).getByRole("switch", { name: "Monitor track on (listen to the input)" }),
      );
      expect(onChange).toHaveBeenLastCalledWith({
        type: "monitor",
        value: { ...monitorTrack, enabled: false },
      });
      expect(within(row).getByRole("slider", { name: "Volume, monitor track" })).toBeVisible();
      expect(within(row).getByRole("slider", { name: "Pan, monitor track" })).toBeVisible();
      await expectNoA11yViolations();
    });

    it("opens the same pedalboard as the tracks, Settings for the input, and is removed", async () => {
      const monitor = monitorProps();
      const base = baseMix();
      const { user, container } = setup({ monitor, mix: { ...base, monitor: monitorTrack } });
      const row = within(container).getByTestId("monitor-track-row");
      const menu = within(row).getByRole("button", { name: "Actions for the monitor track" });

      await user.click(menu);
      await user.click(screen.getByRole("menuitem", { name: "Effects (pedalboard)…" }));
      expect(monitor.onEffects).toHaveBeenCalledTimes(1);
      await user.click(within(row).getByRole("button", { name: "Effects of the monitor track" }));
      expect(monitor.onEffects).toHaveBeenCalledTimes(2);

      await user.click(menu);
      await user.click(screen.getByRole("menuitem", { name: "Input settings…" }));
      expect(monitor.onInputSettings).toHaveBeenCalledWith(menu);

      await user.click(menu);
      await user.click(screen.getByRole("menuitem", { name: "Remove" }));
      expect(monitor.onRemove).toHaveBeenCalled();
    });

    it.each([
      [
        { status: { ...opened, open: false, error: "“Scarlett 2i2 USB” is not connected." } },
        /is not connected/,
      ],
      [{ engineOn: false }, /native audio engine/],
      [{ status: null }, "Opening Scarlett 2i2 USB…"],
      [{ channel: null }, "Scarlett 2i2 USB · all inputs · about 9 ms delay"],
    ])("says why it is silent, or what it hears (%#)", (over, text) => {
      const base = baseMix();
      const { container } = setup({
        monitor: monitorProps(over),
        mix: { ...base, monitor: monitorTrack },
      });
      const row = within(container).getByTestId("monitor-track-row");
      expect(within(row).getByRole("status")).toHaveTextContent(text);
    });

    it("dims the tracks while it is soloed", () => {
      const base = baseMix();
      const { container } = setup({
        monitor: monitorProps(),
        mix: { ...base, monitor: { ...monitorTrack, solo: true } },
      });
      // Every bar of the soloed-out tracks is drawn faded.
      const bars = container.querySelectorAll("button.opacity-40");
      expect(bars.length).toBeGreaterThan(0);
      expect(container.querySelector("button.opacity-100")).toBeNull();
    });
  });

  it("says whether the mix is saved and when pan waits for a pause", () => {
    const { rerender, ...rest } = setup({ saved: true, playing: true });
    expect(screen.getByText(/Mix changes are saved for this song/)).toBeInTheDocument();
    expect(screen.getByText(/Pan changes are applied when you pause/)).toBeInTheDocument();
    void rerender;
    void rest;
  });

  describe("the continuous view (#157)", () => {
    const stacking = { indexes: [0, 2], stacking: true };
    const stackActions = (): TrackActions => ({
      onShow: vi.fn(),
      onMove: vi.fn(),
      onDuplicate: vi.fn(),
      onRemove: vi.fn(),
      onSettings: vi.fn(),
      onLyrics: vi.fn(),
      onAdd: vi.fn(),
      onToggleVisible: vi.fn(),
      onMoveInView: vi.fn(),
    });

    it("only shows the track while the layout is not continuous", async () => {
      const { user, actions } = setup({ stack: { indexes: [0, 2], stacking: false } });

      await user.click(screen.getByRole("button", { name: "Visible: Bass" }));

      expect(actions.onShow).toHaveBeenCalledWith(1);
      expect(screen.queryByTestId("view-handle")).not.toBeInTheDocument();
    });

    it("adds and removes tracks from the eye, and keeps the edited one", async () => {
      const actions = stackActions();
      const { user } = setup({ stack: stacking, actions });

      const guitar = screen.getByRole("button", { name: "Visible: Guitar" });
      expect(guitar).toHaveAttribute("aria-pressed", "true");
      expect(guitar).toBeDisabled();
      expect(screen.getByRole("button", { name: "Visible: Bass" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );

      await user.click(screen.getByRole("button", { name: "Visible: Bass" }));
      await user.click(screen.getByRole("button", { name: "Visible: Drums" }));

      expect(actions.onToggleVisible).toHaveBeenNthCalledWith(1, 1);
      expect(actions.onToggleVisible).toHaveBeenNthCalledWith(2, 2);
      expect(actions.onShow).not.toHaveBeenCalled();
    });

    it("reorders with Alt and the arrows on the name, and with the grip", async () => {
      const actions = stackActions();
      const { user } = setup({ stack: stacking, actions });

      screen.getByRole("button", { name: /^Show Drums/ }).focus();
      await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
      screen.getByRole("button", { name: "Reorder Guitar in the view" }).focus();
      await user.keyboard("{ArrowDown}");

      expect(actions.onMoveInView).toHaveBeenNthCalledWith(1, 2, -1);
      expect(actions.onMoveInView).toHaveBeenNthCalledWith(2, 0, 1);
      expect(screen.getByRole("button", { name: /^Show Drums/ })).toHaveAccessibleName(
        /position 2 of 2 in the view/,
      );
    });

    it("drops a dragged track on another by the distance between them", () => {
      const actions = stackActions();
      setup({ stack: { indexes: [2, 0, 1], stacking: true }, actions });

      // Bass is third in the view; dropped on Drums, which is first: two places up.
      fireEvent.dragStart(screen.getAllByTestId("view-handle")[1]!, {
        dataTransfer: { effectAllowed: "" },
      });
      fireEvent.drop(screen.getAllByRole("listitem")[2]!.firstElementChild!);

      expect(actions.onMoveInView).toHaveBeenCalledWith(1, -2);
    });

    it("offers Move up and down in the view for stacked tracks only", async () => {
      const actions = stackActions();
      const { user } = setup({ stack: stacking, actions });

      await trackAction(user, "Drums", "Move up in the view");
      expect(actions.onMoveInView).toHaveBeenCalledWith(2, -1);

      await user.click(screen.getByRole("button", { name: "Actions for Bass" }));
      expect(screen.queryByRole("menuitem", { name: /in the view/ })).not.toBeInTheDocument();
    });

    it("has no accessibility violations while stacking", async () => {
      setup({ stack: stacking, actions: stackActions() });
      await expectNoA11yViolations();
    });
  });
});
