/**
 * Integration tests for editing, practice tools, the instrument view and
 * track management in the workspace, with a real score and a fake player.
 */
import { act, screen, waitFor, within } from "@testing-library/react";

import { INSTRUMENT_VIEW_STORAGE_KEY, ScoreWorkspace } from "@/components/score/score-workspace";
import { Toaster } from "@/components/ui/sonner";
import type { ScoreDocument } from "@/hooks/use-score-document";
import { fileKey } from "@/lib/score/format";
import { mixFromScore } from "@/lib/score/mixer";
import { parseScore } from "@/lib/score/score";
import type { MenuAction } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { FakeScorePlayer } from "@/test/fake-score-player";
import { renderWithProviders } from "@/test/render";
import { trackAction } from "@/test/track-actions";
import { fixtureBytes } from "@/test/score";
import { backend, emitMenuAction, mockTauri, type IpcCall } from "@/test/tauri";

vi.mock("@/lib/score/player", async () => ({
  ScorePlayer: (await import("@/test/fake-score-player")).FakeScorePlayer,
}));

async function makeSong(): Promise<ScoreDocument> {
  const bytes = fixtureBytes("practice-song.gp");
  const { score, summary } = parseScore(bytes);
  return {
    id: 1,
    name: "practice-song.gp",
    path: null,
    fileKey: await fileKey(bytes),
    score,
    summary,
    mix: mixFromScore(summary),
  };
}

async function setup({ desktop = false, startEditing = false } = {}) {
  const calls: IpcCall[] = desktop ? mockTauri() : [];
  const song = await makeSong();
  const onEditedChange = vi.fn();
  const utils = renderWithProviders(
    <>
      <ScoreWorkspace
        song={song}
        onOpen={vi.fn()}
        onEditedChange={onEditedChange}
        startEditing={startEditing}
      />
      <Toaster />
    </>,
  );
  const player = FakeScorePlayer.last;
  player.becomeReady();
  const score = () => screen.getByRole("region", { name: /^Score:/ });
  /** The editor's status line, which describes the score region. */
  const status = () => document.getElementById(score().getAttribute("aria-describedby")!)!;
  /** The guitar's frets in a bar, e.g. ["1:0", "1:2", ...]. */
  const frets = (bar = 0, track = 0) =>
    song.score.tracks[track]!.staves[0]!.bars[bar]!.voices[0]!.beats.map(
      (b) => b.notes.map((n) => `${n.string}:${n.fret}`).join(" ") || "r",
    );
  return { ...utils, song, player, score, status, frets, calls, onEditedChange };
}

async function startEditing(user: Awaited<ReturnType<typeof setup>>["user"]) {
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByRole("toolbar", { name: "Edit" });
}

/** Waits until the menu listener is registered, then emits `action`. */
async function menu(action: MenuAction) {
  await act(() => emitMenuAction(action));
}

describe("ScoreWorkspace: editing", () => {
  it("writes notes with the keyboard in edit mode, with undo and redo", async () => {
    const { user, player, score, status, frets, onEditedChange } = await setup();
    expect(screen.queryByRole("toolbar", { name: "Edit" })).not.toBeInTheDocument();

    await startEditing(user);
    expect(player.setEditing).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(score()).toHaveFocus());
    expect(score()).toHaveAttribute("aria-roledescription", "score editor");

    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}7");

    expect(frets()).toEqual(["1:7", "1:2", "1:3", "1:0"]);
    expect(player.refresh).toHaveBeenLastCalledWith({
      trackIndex: 0,
      view: { notation: "score-tab", rhythm: false },
      mix: expect.objectContaining({ tracks: expect.any(Array) }),
    });
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(onEditedChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Fret 7 on string 6");
    expect(status()).toHaveTextContent("Bar 1, beat 1 of 4, string 6 (E), fret 7, Quarter");

    await user.click(screen.getByRole("button", { name: "Undo Change note" }));
    expect(frets()[0]).toBe("1:0");
    expect(onEditedChange).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Redo Change note" }));
    expect(frets()[0]).toBe("1:7");
    await expectNoA11yViolations();
  });

  it("changes rhythm from the toolbar", async () => {
    const { user, song } = await setup({ startEditing: true });
    await screen.findByRole("toolbar", { name: "Edit" });

    await user.click(screen.getByRole("radio", { name: "Eighth" }));
    await user.click(screen.getByRole("button", { name: "Dot" }));

    const beat = song.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
    expect(beat.duration).toBe(8);
    expect(beat.dots).toBe(1);
  });

  it("draws the edit cursor and moves it on clicks in the score", async () => {
    const { user, player, song, status } = await setup();
    await startEditing(user);

    player.emit("onRendered");
    expect(screen.getByTestId("edit-cursor")).toHaveStyle({ left: "10px", top: "20px" });
    // No note on the cursor's string (the top one) yet.
    expect(screen.queryByTestId("edit-cursor-note")).not.toBeInTheDocument();

    const beat = song.score.tracks[0]!.staves[0]!.bars[2]!.voices[0]!.beats[1]!;
    player.emit("onBeatClick", { beat, note: beat.notes[0]!, extend: false });
    expect(status()).toHaveTextContent(/^Bar 3, beat 2 of 4/);
    expect(screen.getByTestId("edit-cursor-note")).toBeInTheDocument();

    const other = song.score.tracks[0]!.staves[0]!.bars[3]!.voices[0]!.beats[0]!;
    player.emit("onBeatDrag", other);
    expect(player.beatRects).toHaveBeenCalledWith(beat);
    expect(status()).toHaveTextContent(/^Bar 4, beat 1 of 4/);

    // Beats of other tracks (e.g. from alphaTab's multi-track view) are ignored.
    const bass = song.score.tracks[1]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
    player.emit("onBeatClick", { beat: bass, note: null, extend: false });
    expect(status()).toHaveTextContent(/^Bar 4, beat 1 of 4/);
  });

  it("ignores clicks while viewing", async () => {
    const { player, song } = await setup();
    const beat = song.score.tracks[0]!.staves[0]!.bars[2]!.voices[0]!.beats[1]!;
    player.emit("onBeatClick", { beat, note: null, extend: false });
    expect(player.refresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId("edit-cursor")).not.toBeInTheDocument();
  });

  it("keeps editing the shown track when switching tracks", async () => {
    const { user, frets } = await setup({ startEditing: true });
    await screen.findByRole("toolbar", { name: "Edit" });

    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: "Bass" }));
    screen.getByRole("region", { name: "Score: Bass" }).focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}5");

    expect(frets(0, 1)[0]).toBe("1:5");
  });
});

describe("ScoreWorkspace: instrument view", () => {
  it("shows the fretboard, remembers it, and enters notes from it while editing", async () => {
    const { user, frets } = await setup();

    await user.click(screen.getByRole("button", { name: "Fretboard" }));
    expect(screen.getByRole("region", { name: "Fretboard" })).toBeInTheDocument();
    expect(localStorage.getItem(INSTRUMENT_VIEW_STORAGE_KEY)).toBe("shown");

    await startEditing(user);
    await user.click(screen.getByRole("button", { name: "Fret 12, E5" }));
    expect(frets()[0]).toBe("1:0 6:12");
    await expectNoA11yViolations();
  });

  it("keeps the focus and the arrow keys in the score after clicking the fretboard or a drum pad", async () => {
    const { user, frets } = await setup();
    await user.click(screen.getByRole("button", { name: "Fretboard" }));
    await startEditing(user);
    const score = screen.getByRole("region", { name: /^Score:/ });

    await user.click(screen.getByRole("button", { name: "Fret 12, E5" }));
    expect(score).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowDown}"); // moves between strings, in the score
    expect(score).toHaveFocus();
    expect(frets()[0]).toBe("1:0 6:12");

    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: "Drums" }));
    await user.click(await screen.findByRole("button", { name: "Crash cymbal" }));
    expect(screen.getByRole("region", { name: /^Score:/ })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("region", { name: /^Score:/ })).toHaveFocus();
  });

  it("shows the notes being played", async () => {
    localStorage.setItem(INSTRUMENT_VIEW_STORAGE_KEY, "shown");
    const { player, song } = await setup();
    const beat = song.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[2]!;

    player.emit("onPlayingChange", true);
    player.emit("onActiveBeatsChange", [beat]);

    expect(screen.getByRole("img", { name: /^Fretboard\./ })).toHaveAccessibleName(
      "Fretboard. string 6 fret 3 (G2)",
    );
  });

  it("uses a keyboard for staff-only tracks and pads for drums", async () => {
    localStorage.setItem(INSTRUMENT_VIEW_STORAGE_KEY, "shown");
    const { user } = await setup();

    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: "Piano" }));
    expect(screen.getByRole("region", { name: "Keyboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keyboard" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: "Drums" }));
    expect(screen.getByRole("region", { name: "Drum pads" })).toBeInTheDocument();
  });
});

describe("ScoreWorkspace: practice", () => {
  it("loops bars, changes the speed and plays a metronome and count-in", async () => {
    const { user, player } = await setup();

    player.emit("onBarChange", 2);
    await user.click(screen.getByRole("button", { name: "Loop" }));
    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 2, end: 2 });

    const to = screen.getByRole("spinbutton", { name: "Loop to bar" });
    await user.clear(to);
    await user.type(to, "4{Enter}");
    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 2, end: 3 });

    await user.click(screen.getByRole("combobox", { name: "Speed" }));
    await user.click(await screen.findByRole("option", { name: "75%" }));
    expect(player.setSpeed).toHaveBeenLastCalledWith(75);

    await user.click(screen.getByRole("button", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Count-in" }));
    expect(player.setMetronome).toHaveBeenLastCalledWith(true);
    expect(player.setCountIn).toHaveBeenLastCalledWith(true);
    expect(JSON.parse(localStorage.getItem("smart-beat:practice")!)).toEqual({
      metronome: true,
      countIn: true,
    });

    await user.click(screen.getByRole("button", { name: "Loop" }));
    expect(player.setLoop).toHaveBeenLastCalledWith(null);
  });

  it("loops the bars dragged across in the score", async () => {
    const { user, player } = await setup();

    player.emit("onRangeSelect", { start: 1, end: 3 });
    await user.click(screen.getByRole("button", { name: "Loop" }));

    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 1, end: 3 });
    player.emit("onRangeSelect", { start: 0, end: 1 });
    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 0, end: 1 });
  });

  it("loops the bars selected in the editor", async () => {
    const { user, player } = await setup({ startEditing: true });
    await screen.findByRole("toolbar", { name: "Edit" });
    await waitFor(() => expect(screen.getByRole("region", { name: /^Score:/ })).toHaveFocus());

    // jsdom isn't a Mac: the bar keys use Ctrl.
    await user.keyboard("{Shift>}{Control>}{ArrowRight}{/Control}{/Shift}");
    await user.click(screen.getByRole("button", { name: "Loop" }));

    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 0, end: 1 });
  });

  it("runs the Speed Trainer: starts slow and speeds up after each loop", async () => {
    const { user, player } = await setup();

    await user.click(screen.getByRole("button", { name: "Speed Trainer…" }));
    const dialog = await screen.findByRole("dialog", { name: "Speed Trainer" });
    await user.click(within(dialog).getByRole("button", { name: "Start" }));

    expect(player.setSpeed).toHaveBeenLastCalledWith(60);
    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 0, end: 0 });
    expect(player.playPause).toHaveBeenCalledOnce();
    expect(screen.getByText("Trainer 60% → 100%")).toBeInTheDocument();

    player.emit("onLoopRestart");
    expect(player.setSpeed).toHaveBeenLastCalledWith(70);
    expect(screen.getByText("Trainer 70% → 100%")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop the Speed Trainer" }));
    expect(screen.queryByText(/^Trainer/)).not.toBeInTheDocument();
  });
});

describe("ScoreWorkspace: tracks", () => {
  it("adds a track, which gets a mixer strip and can be undone", async () => {
    const { user, song } = await setup({ desktop: true });

    await user.click(screen.getByRole("button", { name: "Add track" }));
    const dialog = await screen.findByRole("dialog", { name: "Add track" });
    await user.click(within(dialog).getByRole("combobox", { name: "Instrument" }));
    await user.click(await screen.findByRole("option", { name: "Banjo (5 strings)" }));
    await user.click(within(dialog).getByRole("button", { name: "Add track" }));

    expect(song.score.tracks.map((t) => t.name)).toEqual([
      "Guitar",
      "Bass",
      "Drums",
      "Piano",
      "Banjo",
    ]);
    // The new track is shown with its tab, and the score has the keyboard again.
    expect(screen.getByRole("region", { name: "Score: Banjo" })).toBeInTheDocument();
    expect(FakeScorePlayer.last.refresh).toHaveBeenLastCalledWith(
      expect.objectContaining({ trackIndex: 4, view: { notation: "score-tab", rhythm: false } }),
    );
    await waitFor(() => expect(screen.getByRole("region", { name: "Score: Banjo" })).toHaveFocus());
    expect(await screen.findByRole("slider", { name: "Volume, Banjo" })).toHaveAttribute(
      "aria-valuetext",
      "81%",
    );

    await menu("undo");
    await waitFor(() => expect(song.score.tracks).toHaveLength(4));
    expect(screen.getByRole("region", { name: "Score: Guitar" })).toBeInTheDocument();
  });

  it("removes a track with an Undo button in the message", async () => {
    const { user, song } = await setup();

    await trackAction(user, "Drums", "Remove");

    expect(song.score.tracks.map((t) => t.name)).toEqual(["Guitar", "Bass", "Piano"]);
    const message = (await screen.findByText("Removed “Drums”")).closest("li")!;
    await user.click(within(message).getByRole("button", { name: "Undo" }));
    expect(song.score.tracks.map((t) => t.name)).toEqual(["Guitar", "Bass", "Drums", "Piano"]);
  });

  it("keeps each track's mix and the shown track when tracks move", async () => {
    const { user, song, player } = await setup();
    await user.click(screen.getByRole("button", { name: "Solo Bass" }));

    await trackAction(user, "Guitar", "Move down");
    await trackAction(user, "Bass", "Duplicate");

    expect(song.score.tracks.map((t) => t.name)).toEqual([
      "Bass",
      "Bass 2",
      "Guitar",
      "Drums",
      "Piano",
    ]);
    expect(screen.getByRole("region", { name: "Score: Guitar" })).toBeInTheDocument();
    expect(player.refresh).toHaveBeenLastCalledWith(expect.objectContaining({ trackIndex: 2 }));
    expect(await screen.findByRole("button", { name: "Solo Bass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Solo Guitar" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("changes a track's tuning and capo, and reports notes that no longer fit", async () => {
    const { user, song } = await setup();

    await trackAction(user, "Guitar", "Settings…");
    const dialog = await screen.findByRole("dialog", { name: "Track settings" });
    // Keep the fret numbers: notes on the removed string are deleted.
    await user.click(
      within(dialog).getByRole("checkbox", { name: /Keep the pitches of existing notes/ }),
    );
    await user.click(within(dialog).getByRole("combobox", { name: "Strings" }));
    await user.click(await screen.findByRole("option", { name: "5 strings" }));
    const capo = within(dialog).getByRole("spinbutton", { name: "Capo" });
    await user.clear(capo);
    await user.type(capo, "2");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    const staff = song.score.tracks[0]!.staves[0]!;
    expect(staff.tuning).toEqual([64, 59, 55, 50, 45]);
    expect(staff.capo).toBe(2);
    const message = (
      await screen.findByText("4 notes were on removed strings and deleted")
    ).closest("li")!;
    await user.click(within(message).getByRole("button", { name: "Undo" }));
    expect(song.score.tracks[0]!.staves[0]!.tuning).toHaveLength(6);
  });

  it("stops saving the mix once the tracks changed (desktop app)", async () => {
    const { user } = await setup({ desktop: true });
    await trackAction(user, "Piano", "Duplicate");
    expect(
      await screen.findByText("Mix changes last until you close this song."),
    ).toBeInTheDocument();
  });
});

describe("ScoreWorkspace: menu", () => {
  it("keeps the native menu in step", async () => {
    const { user } = await setup({ desktop: true });
    await waitFor(() =>
      expect(backend.menuState).toMatchObject({
        songOpen: true,
        undo: null,
        canRemoveTrack: true,
        editMode: false,
      }),
    );

    await startEditing(user);
    await waitFor(() => expect(screen.getByRole("region", { name: /^Score:/ })).toHaveFocus());
    await user.keyboard("9");
    await user.click(screen.getByRole("button", { name: "Loop" }));

    await waitFor(() =>
      expect(backend.menuState).toMatchObject({
        editMode: true,
        undo: "Add note",
        loop: true,
      }),
    );
  });

  it("runs song commands from the menu", async () => {
    const { player, song, frets } = await setup({ desktop: true });
    // Wait until the workspace listens to menu events.
    await waitFor(async () => {
      await menu("toggle-edit-mode");
      expect(screen.getByRole("toolbar", { name: "Edit" })).toBeInTheDocument();
    });
    await waitFor(() => expect(screen.getByRole("region", { name: /^Score:/ })).toHaveFocus());
    await act(async () => {
      screen
        .getByRole("region", { name: /^Score:/ })
        .dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true }));
    });
    expect(frets()[0]).toBe("1:0 6:4");

    await menu("undo");
    expect(frets()[0]).toBe("1:0");
    await menu("redo");
    expect(frets()[0]).toBe("1:0 6:4");

    await menu("toggle-loop");
    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 0, end: 0 });
    await menu("toggle-metronome");
    expect(player.setMetronome).toHaveBeenLastCalledWith(true);
    await menu("toggle-count-in");
    expect(player.setCountIn).toHaveBeenLastCalledWith(true);
    await menu("toggle-fretboard");
    expect(screen.getByRole("region", { name: "Fretboard" })).toBeInTheDocument();

    await menu("duplicate-track");
    expect(song.score.tracks.map((t) => t.name)).toContain("Guitar 2");
    await menu("remove-track");
    expect(song.score.tracks.map((t) => t.name)).not.toContain("Guitar");

    await menu("track-settings");
    expect(await screen.findByRole("dialog", { name: "Track settings" })).toBeInTheDocument();
  });

  it("opens the add-track dialog and the Speed Trainer from the menu", async () => {
    await setup({ desktop: true });
    await waitFor(async () => {
      await menu("add-track");
      expect(screen.getByRole("dialog", { name: "Add track" })).toBeInTheDocument();
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await menu("speed-trainer");
    expect(await screen.findByRole("dialog", { name: "Speed Trainer" })).toBeInTheDocument();
  });

  it("undoes typing in a text field instead of the score when it has focus", async () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    const { user, frets } = await setup({ desktop: true, startEditing: true });
    await screen.findByRole("toolbar", { name: "Edit" });
    await waitFor(() => expect(screen.getByRole("region", { name: /^Score:/ })).toHaveFocus());
    await user.keyboard("8");

    await user.click(screen.getByRole("spinbutton", { name: "Bar" }));
    await waitFor(async () => {
      await menu("undo");
      expect(execCommand).toHaveBeenCalledWith("undo");
    });
    expect(frets()[0]).toBe("1:0 6:8");
  });
});
