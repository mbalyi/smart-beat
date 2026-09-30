/**
 * Integration tests for the song's structure, techniques, lyrics, chords and
 * the scale tool in the workspace, with a real score and a fake player.
 */
import { act, screen, waitFor, within } from "@testing-library/react";

import { ScoreWorkspace } from "@/components/score/score-workspace";
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
import { backend, emitMenuAction, mockTauri } from "@/test/tauri";

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

/** The workspace in edit mode, with the cursor on the guitar's first note (low E). */
async function setup({ desktop = true } = {}) {
  if (desktop) mockTauri();
  const song = await makeSong();
  const utils = renderWithProviders(
    <>
      <ScoreWorkspace song={song} onOpen={vi.fn()} startEditing />
      <Toaster />
    </>,
  );
  const player = FakeScorePlayer.last;
  player.becomeReady();
  await screen.findByRole("toolbar", { name: "Edit" });
  const region = screen.getByRole("region", { name: /^Score:/ });
  await waitFor(() => expect(region).toHaveFocus());
  await utils.user.keyboard("{ArrowDown>5/}");
  const note = (beat = 0, bar = 0) =>
    song.score.tracks[0]!.staves[0]!.bars[bar]!.voices[0]!.beats[beat]!.notes[0]!;
  const announced = () => screen.getByRole("status", { name: "" });
  return { ...utils, song, player, region, note, announced };
}

async function menu(action: MenuAction) {
  await act(() => emitMenuAction(action));
}

describe("ScoreWorkspace: song structure", () => {
  it("changes a bar's time signature from the toolbar, with undo", async () => {
    const { user, song, player } = await setup();
    await user.click(screen.getByRole("button", { name: "Bar…" }));
    const dialog = await screen.findByRole("dialog", { name: "Bar 1" });
    const beats = within(dialog).getByRole("spinbutton", { name: "Beats per bar" });
    await user.clear(beats);
    await user.type(beats, "3");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(song.score.masterBars.map((b) => b.timeSignatureNumerator)).toEqual([3, 3, 3, 3]);
    expect(player.refresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Undo Change time signature" })).toBeEnabled();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Bar 1: time signature changed",
    );
    await waitFor(() => expect(screen.getByRole("region", { name: /^Score:/ })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Undo Change time signature" }));
    expect(song.score.masterBars[2]!.timeSignatureNumerator).toBe(4);
  });

  it("closes the bar dialog without changes when nothing changed", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Bar…" }));
    await user.click(await screen.findByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeDisabled();
  });

  it("opens the bar dialog and toggles repeats from the Bar menu", async () => {
    const { song } = await setup();
    await menu("toggle-repeat-start");
    await menu("toggle-repeat-end");
    expect(song.score.masterBars[0]!.isRepeatStart).toBe(true);
    expect(song.score.masterBars[0]!.repeatCount).toBe(2);
    await waitFor(() =>
      expect(backend.menuState).toMatchObject({ repeatStart: true, repeatEnd: true }),
    );
    await menu("toggle-repeat-end");
    expect(song.score.masterBars[0]!.repeatCount).toBe(0);

    await menu("bar-settings");
    expect(await screen.findByRole("dialog", { name: "Bar 1" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Repeat starts here" })).toBeChecked();
    await expectNoA11yViolations();
  });

  it("ignores the Bar and Note menus outside edit mode", async () => {
    const { user, song, note } = await setup();
    await user.click(screen.getByRole("button", { name: "Edit" })); // leave edit mode
    await menu("toggle-repeat-start");
    await menu("toggle-palm-mute");
    await menu("bar-settings");
    expect(song.score.masterBars[0]!.isRepeatStart).toBe(false);
    expect(note().isPalmMute).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ScoreWorkspace: techniques", () => {
  it("switches effects from the toolbar, the keys and the Note menu, keeping the menu in step", async () => {
    const { user, note, player } = await setup();
    await waitFor(() => expect(backend.menuState).toMatchObject({ hasNote: true }));
    const toolbar = screen.getByRole("toolbar", { name: "Effects" });

    await user.click(within(toolbar).getByRole("button", { name: "Palm mute" }));
    expect(note().isPalmMute).toBe(true);
    expect(player.refresh).toHaveBeenCalled();
    expect(within(toolbar).getByRole("button", { name: "Palm mute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(backend.menuState?.noteEffects).toMatchObject({ palmMute: true, vibrato: false }),
    );

    await menu("toggle-vibrato");
    expect(note().vibrato).toBe(1);
    await menu("toggle-dead-note");
    expect(note().isDead).toBe(true);
    await waitFor(() =>
      expect(backend.menuState?.noteEffects).toMatchObject({ vibrato: true, deadNote: true }),
    );
    expect(screen.getByRole("region", { name: /^Score:/ })).toHaveAccessibleDescription(
      /vibrato, palm mute, dead note/,
    );

    // Another string: no note there, so the Note menu's effects are unavailable.
    await user.keyboard("{ArrowUp}");
    await waitFor(() =>
      expect(backend.menuState).toMatchObject({ hasNote: false, noteEffects: { palmMute: false } }),
    );
  });

  it("bends the note with the bend editor (Shift+B)", async () => {
    const { user, note } = await setup();
    await user.keyboard("{Shift>}B{/Shift}");
    const dialog = await screen.findByRole("dialog", { name: "Bend" });
    await user.click(within(dialog).getByRole("radio", { name: "Pre-bend" }));
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(note().hasBend).toBe(true);
    expect(screen.getByRole("button", { name: "Undo Add bend" })).toBeEnabled();

    await menu("bend");
    const again = await screen.findByRole("dialog", { name: "Bend" });
    await user.click(within(again).getByRole("button", { name: "Remove bend" }));
    expect(note().hasBend).toBe(false);
  });

  it("says why the bend editor doesn't open without a note", async () => {
    const { user } = await setup();
    await user.keyboard("{ArrowUp}{Shift>}B{/Shift}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("No note at the cursor");
  });

  it("puts the whammy bar on the beat", async () => {
    const { user, note } = await setup();
    await user.click(screen.getByRole("button", { name: "Whammy…" }));
    const dialog = await screen.findByRole("dialog", { name: "Whammy bar" });
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(note().beat.hasWhammyBar).toBe(true);
  });
});

describe("ScoreWorkspace: text, chords, lyrics and scales", () => {
  it("writes text and chords on the beat", async () => {
    const { user, note } = await setup();
    await menu("text");
    const textDialog = await screen.findByRole("dialog", { name: "Text" });
    await user.type(within(textDialog).getByRole("textbox", { name: "Text" }), "slowly");
    await user.click(within(textDialog).getByRole("button", { name: "Apply" }));
    expect(note().beat.text).toBe("slowly");

    await menu("chord");
    const chordDialog = await screen.findByRole("dialog", { name: "Chord" });
    // The cursor's single note (open low E) is the diagram to start from.
    expect(within(chordDialog).getByRole("combobox", { name: /String 6/ })).toHaveTextContent(
      "Open",
    );
    await user.type(within(chordDialog).getByRole("textbox", { name: "Name" }), "E5");
    await user.click(within(chordDialog).getByRole("button", { name: "Apply" }));
    expect(note().beat.chord?.name).toBe("E5");
    expect(screen.getByRole("button", { name: "Undo Add chord" })).toBeEnabled();
  });

  it("names the chord of the selected notes", async () => {
    const { user } = await setup();
    // Piano: whole-note chords, C major first.
    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: /Piano/ }));
    await menu("chord");
    const dialog = await screen.findByRole("dialog", { name: "Chord" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("C");
    expect(within(dialog).queryByRole("group", { name: "Diagram" })).not.toBeInTheDocument();
  });

  it("adds lyrics from the Track menu and shows them in the lyrics strip", async () => {
    const { user, song } = await setup();
    expect(screen.queryByRole("region", { name: "Lyrics" })).not.toBeInTheDocument();
    await menu("lyrics");
    const dialog = await screen.findByRole("dialog", { name: "Lyrics: Guitar" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Line 1 text" }),
      "Sing-ing a song",
    );
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    const beats = song.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    expect(beats.map((b) => b.lyrics?.[0])).toEqual(["Sing-", "ing", "a", "song"]);
    const strip = screen.getByRole("region", { name: "Lyrics" });
    expect(strip).toHaveTextContent("Sing-ing a song");
    expect(strip.querySelector("[aria-current='true']")).toHaveTextContent("Sing");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(strip.querySelector("[aria-current='true']")).toHaveTextContent("a");

    await user.click(screen.getByRole("button", { name: "Undo Change lyrics" }));
    expect(screen.queryByRole("region", { name: "Lyrics" })).not.toBeInTheDocument();
    expect(beats[0]!.lyrics).toBeNull();
  });

  it("opens lyrics from a track's menu", async () => {
    const { user } = await setup();
    await trackAction(user, "Bass", "Lyrics…");
    expect(await screen.findByRole("dialog", { name: "Lyrics: Bass" })).toBeInTheDocument();
  });

  it("shows the scale tool from the View menu", async () => {
    const { user } = await setup();
    expect(screen.queryByRole("region", { name: "Fretboard" })).not.toBeInTheDocument();
    await menu("scale-tool");
    const picker = await screen.findByRole("combobox", { name: "Scale" });
    await waitFor(() => expect(picker).toHaveFocus());
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: "Major pentatonic" }));
    // The song is in C: the scale starts there.
    expect(screen.getByRole("region", { name: "Fretboard" })).toHaveTextContent(
      "C major pentatonic: C D E G A",
    );
    await expectNoA11yViolations();
  });

  it("has no scale tool on drum tracks", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: /Drums/ }));
    await menu("scale-tool");
    expect(
      await screen.findByText("The scale tool works on stringed and keyboard tracks"),
    ).toBeInTheDocument();
  });
});
