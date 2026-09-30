/**
 * Integration tests for saving, exporting, transposing and fixing bar lengths
 * in the workspace, with a real score and a fake player.
 */
import { act, screen, waitFor, within } from "@testing-library/react";

import { ScoreWorkspace } from "@/components/score/score-workspace";
import { Toaster } from "@/components/ui/sonner";
import type { SavedAs, ScoreDocument } from "@/hooks/use-score-document";
import { barProblems } from "@/lib/score/bar-duration";
import { fileKey } from "@/lib/score/format";
import { mixFromScore } from "@/lib/score/mixer";
import { parseScore } from "@/lib/score/score";
import type { MenuAction } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { FakeScorePlayer } from "@/test/fake-score-player";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes } from "@/test/score";
import { backend, emitMenuAction, mockTauri } from "@/test/tauri";

vi.mock("@/lib/score/player", async () => ({
  ScorePlayer: (await import("@/test/fake-score-player")).FakeScorePlayer,
}));

async function makeSong(path: string | null = null): Promise<ScoreDocument> {
  const bytes = fixtureBytes("practice-song.gp");
  const { score, summary } = parseScore(bytes);
  return {
    id: 1,
    name: "practice-song.gp",
    path,
    fileKey: await fileKey(bytes),
    score,
    summary,
    mix: mixFromScore(summary),
  };
}

async function setup({ desktop = true, path = null as string | null } = {}) {
  const calls = desktop ? mockTauri() : [];
  const song = await makeSong(path);
  const onSaved = vi.fn<(saved: SavedAs) => void>();
  const onEditedChange = vi.fn();
  const utils = renderWithProviders(
    <>
      <ScoreWorkspace
        song={song}
        onOpen={vi.fn()}
        onSaved={onSaved}
        onEditedChange={onEditedChange}
      />
      <Toaster />
    </>,
  );
  FakeScorePlayer.last.becomeReady();
  return { ...utils, song, calls, onSaved, onEditedChange, player: FakeScorePlayer.last };
}

const menu = (action: MenuAction) => act(() => emitMenuAction(action));

/** Makes the song "edited" by transposing the guitar, like a user would. */
async function edit(user: Awaited<ReturnType<typeof setup>>["user"]) {
  await user.click(screen.getByRole("button", { name: "Tools" }));
  await user.click(await screen.findByRole("menuitem", { name: "Transpose…" }));
  const dialog = await screen.findByRole("dialog", { name: "Transpose" });
  await user.click(within(dialog).getByRole("button", { name: "Transpose" }));
  await waitFor(() => expect(screen.getByText("Edited")).toBeInTheDocument());
}

/** The toast (not the status line) that shows `message`. */
async function toastWith(message: string) {
  const found = await screen.findAllByText(message);
  return found.map((el) => el.closest("li")).find((li): li is HTMLLIElement => li !== null)!;
}

const bytesOf = (path: string) => backend.written.get(path)!;
const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("ScoreWorkspace: saving (desktop app)", () => {
  it("saves a new file with Save As, then follows it", async () => {
    const { user, onSaved, onEditedChange } = await setup();
    await edit(user);
    backend.saveResult = "/songs/mine.gp";

    await menu("save-as");

    await waitFor(() => expect(backend.written.has("/songs/mine.gp")).toBe(true));
    expect(isZip(bytesOf("/songs/mine.gp"))).toBe(true); // Guitar Pro 7 (.gp) is a ZIP
    const saved = onSaved.mock.calls[0]![0];
    expect(saved).toMatchObject({ name: "mine.gp", path: "/songs/mine.gp" });
    expect(saved.fileKey).toMatch(/^[0-9a-f]{64}$/);
    expect(onEditedChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(screen.queryByText("Edited")).not.toBeInTheDocument());
    expect((await screen.findAllByText("Saved “mine.gp”")).length).toBeGreaterThan(0);
  });

  it("starts the Save dialog in the song's folder, named after the song", async () => {
    const { user, calls } = await setup({ path: "/songs/practice-song.gp4" });
    backend.saveResult = null;
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "Save As…" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:dialog|save")).toBe(true));
    const dialog = calls.find((c) => c.cmd === "plugin:dialog|save")!;
    expect(dialog.args).toMatchObject({
      options: {
        title: "Save As",
        defaultPath: "/songs/practice-song.gp",
        filters: [
          { name: "Guitar Pro 7 (Smart Beat native)", extensions: ["gp"] },
          { name: "Guitar Pro 5", extensions: ["gp5"] },
        ],
      },
    });
    // Cancelled: nothing is written.
    expect(backend.written.size).toBe(0);
  });

  it("saves over the file it was opened from, without asking", async () => {
    const { user, onSaved } = await setup({ path: "/songs/practice-song.gp" });
    await edit(user);

    await menu("save");

    await waitFor(() => expect(backend.written.has("/songs/practice-song.gp")).toBe(true));
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ name: "practice-song.gp", path: "/songs/practice-song.gp" }),
    );
  });

  it("saves a Guitar Pro 5 file as Guitar Pro 5 and lists what it could not keep", async () => {
    const { user } = await setup({ path: "/songs/old.gp5" });
    await edit(user);

    await menu("save");

    await waitFor(() => expect(backend.written.has("/songs/old.gp5")).toBe(true));
    expect(text(bytesOf("/songs/old.gp5").slice(1, 25))).toBe("FICHIER GUITAR PRO v5.00");
    expect((await screen.findAllByText("“old.gp5” was saved with limits")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/Guitar Pro 5 has no keyboard staff/).length).toBeGreaterThan(0);
  });

  it("asks where to save a file it cannot write back (Guitar Pro 4, MIDI)", async () => {
    const { user } = await setup({ path: "/songs/old.gp4" });
    backend.saveResult = "/songs/old.gp";
    await menu("save");
    await waitFor(() => expect(backend.written.has("/songs/old.gp")).toBe(true));
    expect(backend.written.has("/songs/old.gp4")).toBe(false);
    void user;
  });

  it("asks where to save a new song", async () => {
    await setup();
    backend.saveResult = "/songs/new";
    await menu("save");
    // No extension chosen: the native format's.
    await waitFor(() => expect(backend.written.has("/songs/new.gp")).toBe(true));
  });

  it("saves as Guitar Pro 5 when that file type is chosen", async () => {
    await setup();
    backend.saveResult = "/songs/mine.GP5";
    await menu("save-as");
    await waitFor(() => expect(backend.written.has("/songs/mine.GP5")).toBe(true));
    expect(text(bytesOf("/songs/mine.GP5").slice(1, 25))).toBe("FICHIER GUITAR PRO v5.00");
  });

  it("does nothing when the Save dialog is cancelled", async () => {
    const { onSaved } = await setup();
    backend.saveResult = null;
    await menu("save-as");
    await act(async () => {});
    expect(backend.written.size).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("reports a file that could not be written and keeps the changes", async () => {
    mockTauri({
      write_score_file: () => {
        throw { kind: "io", message: "“a.gp” could not be saved: disk full" };
      },
    });
    const song = await makeSong();
    const onSaved = vi.fn();
    renderWithProviders(
      <>
        <ScoreWorkspace song={song} onOpen={vi.fn()} onSaved={onSaved} />
        <Toaster />
      </>,
    );
    FakeScorePlayer.last.becomeReady();
    backend.saveResult = "/songs/a.gp";

    await menu("save-as");

    expect((await screen.findAllByText("Couldn't save the file")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/disk full/).length).toBeGreaterThan(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("writes the mixer's volume and pan into the file", async () => {
    const { user } = await setup();
    backend.saveResult = "/songs/mix.gp";
    await user.click(screen.getByRole("button", { name: "Mixer" }));
    const pan = await screen.findByRole("slider", { name: /Pan.*Guitar|Guitar.*pan/i });
    pan.focus();
    await user.keyboard("{Home}");
    await user.keyboard("{Escape}");
    await menu("save-as");
    await waitFor(() => expect(backend.written.has("/songs/mix.gp")).toBe(true));
    const again = parseScore(bytesOf("/songs/mix.gp")).score;
    expect(again.tracks[0]!.playbackInfo.balance).toBe(0);
  });

  it("exports MusicXML, MIDI and ASCII tab without changing the song's file", async () => {
    const { user, onSaved } = await setup();
    backend.saveResult = "/out/song.musicxml";
    await menu("export-musicxml");
    await waitFor(() => expect(backend.written.has("/out/song.musicxml")).toBe(true));
    expect(text(bytesOf("/out/song.musicxml"))).toContain("<score-partwise");

    backend.saveResult = "/out/song.mid";
    await menu("export-midi");
    await waitFor(() => expect(backend.written.has("/out/song.mid")).toBe(true));
    expect(text(bytesOf("/out/song.mid").slice(0, 4))).toBe("MThd");

    backend.saveResult = "/out/song";
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "ASCII tab…" }));
    await waitFor(() => expect(backend.written.has("/out/song.txt")).toBe(true));
    expect(text(bytesOf("/out/song.txt"))).toContain("Practice Song - Smart Beat");
    expect(onSaved).not.toHaveBeenCalled();
    expect((await screen.findAllByText(/tab.*left out|has no strings/)).length).toBeGreaterThan(0);
  });

  it("ignores a second save while one is running", async () => {
    let release: () => void = () => {};
    const calls = mockTauri({
      write_score_file: () => new Promise<null>((resolve) => (release = () => resolve(null))),
    });
    const song = await makeSong();
    renderWithProviders(
      <>
        <ScoreWorkspace song={song} onOpen={vi.fn()} />
        <Toaster />
      </>,
    );
    FakeScorePlayer.last.becomeReady();
    backend.saveResult = "/songs/a.gp";
    await menu("save-as");
    await waitFor(() => expect(calls.filter((c) => c.cmd === "write_score_file")).toHaveLength(1));
    await menu("save-as");
    await act(async () => release());
    await waitFor(() => expect(screen.getAllByText("Saved “a.gp”").length).toBeGreaterThan(0));
    expect(calls.filter((c) => c.cmd === "plugin:dialog|save")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "write_score_file")).toHaveLength(1);
  });
});

describe("ScoreWorkspace: saving (browser)", () => {
  it("downloads the file instead of writing it", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      created.push(blob as Blob);
      return "blob:test";
    });
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    const { user, onSaved } = await setup({ desktop: false });

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "Save" }));

    await waitFor(() => expect(names).toEqual(["Practice Song.gp"]));
    expect(created[0]!.size).toBeGreaterThan(100);
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Practice Song.gp", path: null }),
    );

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "MIDI…" }));
    await waitFor(() => expect(names).toEqual(["Practice Song.gp", "Practice Song.mid"]));
    click.mockRestore();
  });
});

describe("ScoreWorkspace: transpose", () => {
  it("transposes the track from the Tools menu and offers undo", async () => {
    const { user, song } = await setup();
    const first = () => song.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    const before = first().fret;

    await user.click(screen.getByRole("button", { name: "Tools" }));
    await user.click(await screen.findByRole("menuitem", { name: "Transpose…" }));
    const dialog = await screen.findByRole("dialog", { name: "Transpose" });
    expect(within(dialog).getByRole("combobox", { name: "Transpose" })).toHaveTextContent(
      "This track",
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "16 notes will move up 2 semitones.",
    );
    await expectNoA11yViolations();
    await user.click(within(dialog).getByRole("button", { name: "Transpose" }));

    expect(first().fret).toBe(before + 2);
    const toast = await toastWith("Moved 16 notes up 2 semitones");
    await user.click(within(toast).getByRole("button", { name: "Undo" }));
    expect(first().fret).toBe(before);
  });

  it("previews problems and blocks a move that does not fit", async () => {
    const { user, song } = await setup();
    await menu("transpose");
    const dialog = await screen.findByRole("dialog", { name: "Transpose" });
    const amount = within(dialog).getByRole("spinbutton", { name: /Semitones/ });
    await user.clear(amount);
    await user.type(amount, "-30");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Enter 1 to 24 semitones");
    expect(within(dialog).getByRole("button", { name: "Transpose" })).toBeDisabled();
    await user.clear(amount);
    await user.type(amount, "-24");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      /do(es)? not fit on the instrument/,
    );
    expect(within(dialog).getByRole("button", { name: "Transpose" })).toBeDisabled();
    await user.clear(amount);
    await user.type(amount, "0");
    expect(within(dialog).getByRole("button", { name: "Transpose" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "One semitone up" }));
    expect(within(dialog).getByRole("button", { name: "Transpose" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(song.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.fret).toBe(0);
  });

  it("offers the key signatures for a track or song, not for a selection", async () => {
    const { user } = await setup();
    await menu("transpose");
    const dialog = await screen.findByRole("dialog", { name: "Transpose" });
    expect(
      within(dialog).getByRole("checkbox", { name: "Also move the key signatures" }),
    ).toBeChecked();
    await user.click(within(dialog).getByRole("combobox", { name: "Transpose" }));
    await user.click(await screen.findByRole("option", { name: /Whole song/ }));
    expect(within(dialog).getByRole("status")).toHaveTextContent(/\d+ notes will move/);
    await user.click(within(dialog).getByRole("combobox", { name: "Transpose" }));
    await user.click(await screen.findByRole("option", { name: /Selection/ }));
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("ScoreWorkspace: bar lengths", () => {
  /** Changes bar 1's time signature to 3/4, which leaves the bar too long. */
  async function breakBar(user: Awaited<ReturnType<typeof setup>>["user"]) {
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(await screen.findByRole("button", { name: "Bar…" }));
    const dialog = await screen.findByRole("dialog", { name: "Bar 1" });
    const beats = within(dialog).getByRole("spinbutton", { name: "Beats per bar" });
    await user.clear(beats);
    await user.type(beats, "3");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
  }

  it("warns about bars with the wrong length, highlights them and fixes them", async () => {
    const { user, song, player } = await setup();
    expect(screen.queryByRole("status", { name: "Bar lengths" })).not.toBeInTheDocument();

    await breakBar(user);

    const banner = await screen.findByRole("status", { name: "Bar lengths" });
    expect(banner).toHaveTextContent("4 bars have the wrong length: 1, 2, 3, 4");
    expect(barProblems(song.score, 0)).toHaveLength(4);
    await act(async () => player.callbacks.onRendered?.());
    expect(screen.getAllByTestId("bar-problem")).toHaveLength(4);

    await user.click(within(banner).getByRole("button", { name: "Fix all" }));

    expect(barProblems(song.score, 0)).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Bar lengths" })).not.toBeInTheDocument(),
    );
    const toast = await toastWith("Fixed 4 bars");
    await user.click(within(toast).getByRole("button", { name: "Undo" }));
    expect(barProblems(song.score, 0)).toHaveLength(4);
  });

  it("goes to the first wrong bar", async () => {
    const { user, player } = await setup();
    await breakBar(user);
    const banner = await screen.findByRole("status", { name: "Bar lengths" });
    await user.click(within(banner).getByRole("button", { name: "Go to bar 1" }));
    expect(player.seekToBar).toHaveBeenCalledWith(0);
  });

  it("fixes from the Tools menu and the Bar menu, and says when all is well", async () => {
    const { user, song } = await setup();
    await user.click(screen.getByRole("button", { name: "Tools" }));
    await user.click(await screen.findByRole("menuitem", { name: "Fix bar durations…" }));
    expect(
      (await screen.findAllByText("All bars of this track have the right length")).length,
    ).toBeGreaterThan(0);

    await breakBar(user);
    await menu("fix-bar-durations");
    expect(barProblems(song.score, 0)).toEqual([]);
  });
});

describe("ScoreWorkspace: tuning and pitches", () => {
  it("keeps the pitches when the tuning changes (the default)", async () => {
    const { user, song } = await setup();
    const staff = song.score.tracks[0]!.staves[0]!;
    const pitches = () =>
      staff.bars.flatMap((bar) =>
        bar.voices[0]!.beats.flatMap((b) => b.notes.map((n) => n.realValue)),
      );
    const before = pitches();

    await user.click(screen.getByRole("button", { name: "Tracks" }));
    await user.click(await screen.findByRole("button", { name: "Settings… for Guitar" }));
    const dialog = await screen.findByRole("dialog", { name: "Track settings" });
    await user.click(within(dialog).getByRole("button", { name: "Lower string 6" }));
    await user.click(within(dialog).getByRole("button", { name: "Lower string 6" }));
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(staff.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(pitches()).toEqual(before); // same sound, other frets
    const low = staff.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    expect([low.string, low.fret]).toEqual([1, 2]); // the open low E is fret 2 of a low D string
  });

  it("deletes notes that cannot be played in the new tuning, and offers undo", async () => {
    const { user, song } = await setup();
    await user.click(screen.getByRole("button", { name: "Tracks" }));
    await user.click(await screen.findByRole("button", { name: "Settings… for Guitar" }));
    const dialog = await screen.findByRole("dialog", { name: "Track settings" });
    const capo = within(dialog).getByRole("spinbutton", { name: "Capo" });
    await user.clear(capo);
    await user.type(capo, "9");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    const message = (await screen.findByText(/could not be played in the new tuning/)).closest(
      "li",
    )!;
    await user.click(within(message).getByRole("button", { name: "Undo" }));
    expect(song.score.tracks[0]!.staves[0]!.capo).toBe(0);
  });
});
