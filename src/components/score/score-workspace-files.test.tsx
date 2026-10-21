/**
 * Integration tests for saving, exporting, transposing and fixing bar lengths
 * in the workspace, with a real score and a fake player.
 */
import { act, screen, waitFor, within } from "@testing-library/react";

import { ScoreWorkspace } from "@/components/score/score-workspace";
import { Toaster } from "@/components/ui/sonner";
import type { SavedAs, ScoreDocument } from "@/hooks/use-score-document";
import { defaultEffect } from "@/lib/audio/effects";
import { storeAudioInput, storeAudioInputChannel } from "@/lib/audio/input";
import { DEFAULT_MONITOR, rememberMonitorTrack } from "@/lib/audio/monitor";
import { barProblems } from "@/lib/score/bar-duration";
import { fileKey } from "@/lib/score/format";
import { mixFromScore } from "@/lib/score/mixer";
import { parseScore } from "@/lib/score/score";
import type { MenuAction } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { FakeScorePlayer } from "@/test/fake-score-player";
import { renderWithProviders } from "@/test/render";
import { trackAction } from "@/test/track-actions";
import { fixtureBytes } from "@/test/score";
import { APP_INFO, backend, emitMenuAction, mockTauri } from "@/test/tauri";

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
    await waitFor(() => expect(onSaved).toHaveBeenCalled()); // after the content key is computed
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
          { name: "Guitar Pro 4", extensions: ["gp4"] },
          { name: "Guitar Pro 3", extensions: ["gp3"] },
          { name: "MuseScore", extensions: ["mscz"] },
          { name: "MuseScore, uncompressed", extensions: ["mscx"] },
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
    // The file is written first, then the song is told it was saved.
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ name: "practice-song.gp", path: "/songs/practice-song.gp" }),
      ),
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

  it("saves as Guitar Pro 4 or 3 when that file type is chosen, and lists what they cannot keep", async () => {
    await setup();
    backend.saveResult = "/songs/mine.gp4";
    await menu("save-as");
    await waitFor(() => expect(backend.written.has("/songs/mine.gp4")).toBe(true));
    expect(text(bytesOf("/songs/mine.gp4").slice(1, 25))).toBe("FICHIER GUITAR PRO v4.06");
    expect((await screen.findAllByText("“mine.gp4” was saved with limits")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/Guitar Pro 4 has no keyboard staff/).length).toBeGreaterThan(0);

    backend.saveResult = "/songs/mine.gp3";
    await menu("save-as");
    await waitFor(() => expect(backend.written.has("/songs/mine.gp3")).toBe(true));
    expect(text(bytesOf("/songs/mine.gp3").slice(1, 25))).toBe("FICHIER GUITAR PRO v3.00");
    expect(parseScore(bytesOf("/songs/mine.gp3")).score.tracks).toHaveLength(4);
  });

  it("saves as MuseScore (.mscz and .mscx) and lists what MuseScore files do not carry", async () => {
    await setup();
    backend.saveResult = "/songs/mine.mscz";
    await menu("save-as");
    await waitFor(() => expect(backend.written.has("/songs/mine.mscz")).toBe(true));
    expect(isZip(bytesOf("/songs/mine.mscz"))).toBe(true);
    expect(
      (await screen.findAllByText("“mine.mscz” was saved with limits")).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Tablature is saved as standard notation/).length).toBeGreaterThan(
      0,
    );

    backend.saveResult = "/songs/mine.mscx";
    await menu("save-as");
    await waitFor(() => expect(backend.written.has("/songs/mine.mscx")).toBe(true));
    expect(text(bytesOf("/songs/mine.mscx"))).toContain("<museScore");
  });

  it("does not save over a Guitar Pro 4 file it was opened from, but asks (the writer is checked with alphaTab only)", async () => {
    const { onSaved } = await setup({ path: "/songs/old.gp4" });
    backend.saveResult = "/songs/old.gp4";

    await menu("save");

    // Save As is asked for, and the song is saved as the file the user picked.
    await waitFor(() => expect(backend.written.has("/songs/old.gp4")).toBe(true));
    // The file is written before the app is told: wait for that too (slow on Windows runners).
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ path: "/songs/old.gp4" })),
    );
    expect((await screen.findAllByText("“old.gp4” was saved with limits")).length).toBeGreaterThan(
      0,
    );
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

  it("exports alphaTex from the File menu and from the native menu", async () => {
    const { user, onSaved } = await setup();
    backend.saveResult = "/out/song";
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "alphaTex…" }));
    await waitFor(() => expect(backend.written.has("/out/song.atex")).toBe(true));
    expect(text(bytesOf("/out/song.atex"))).toContain('\\title "Practice Song"');

    backend.saveResult = "/out/native.atex";
    await menu("export-alphatex");
    await waitFor(() => expect(backend.written.has("/out/native.atex")).toBe(true));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("exports every Guitar Pro version from the File menu and from the native menu (#119)", async () => {
    const { user, onSaved } = await setup();
    await user.click(screen.getByRole("button", { name: "File" }));
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    const first = items.indexOf("Smart Beat / Guitar Pro 7…");
    expect(items.slice(first, first + 4)).toEqual([
      "Smart Beat / Guitar Pro 7…",
      "Guitar Pro 5…",
      "Guitar Pro 4…",
      "Guitar Pro 3…",
    ]);
    expect(first).toBeLessThan(items.indexOf("MusicXML…"));
    await user.keyboard("{Escape}");

    backend.saveResult = "/out/menu";
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "Guitar Pro 5…" }));
    await waitFor(() => expect(backend.written.has("/out/menu.gp5")).toBe(true));

    for (const [action, path] of [
      ["export-gp", "/out/native.gp"],
      ["export-gp5", "/out/native5.gp5"],
      ["export-gp4", "/out/native4.gp4"],
      ["export-gp3", "/out/native3.gp3"],
    ] as const) {
      backend.saveResult = path;
      await menu(action);
      await waitFor(() => expect(backend.written.has(path)).toBe(true));
    }
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("exports compressed MusicXML when the file name ends in .mxl", async () => {
    const { calls } = await setup();
    backend.saveResult = "/out/song.mxl";
    await menu("export-musicxml");
    await waitFor(() => expect(backend.written.has("/out/song.mxl")).toBe(true));
    expect(isZip(bytesOf("/out/song.mxl"))).toBe(true);
    // The name is kept: no ".musicxml" is added.
    expect(backend.written.has("/out/song.mxl.musicxml")).toBe(false);
    const dialog = calls.find((c) => c.cmd === "plugin:dialog|save")!;
    expect(dialog.args).toMatchObject({
      options: {
        title: "Export MusicXML (.musicxml)",
        filters: [
          { name: "MusicXML", extensions: ["musicxml"] },
          { name: "Compressed MusicXML", extensions: ["mxl"] },
        ],
      },
    });

    // Plain MusicXML as before.
    backend.saveResult = "/out/plain.musicxml";
    await menu("export-musicxml");
    await waitFor(() => expect(backend.written.has("/out/plain.musicxml")).toBe(true));
    expect(text(bytesOf("/out/plain.musicxml"))).toContain("<score-partwise");
  });

  it("adds .musicxml when the name has another extension", async () => {
    await setup();
    backend.saveResult = "/out/song.xml";
    await menu("export-musicxml");
    await waitFor(() => expect(backend.written.has("/out/song.xml.musicxml")).toBe(true));
  });

  it("exports the mix as a WAV file, named after the song, with progress", async () => {
    const { user, player, onSaved } = await setup();
    backend.saveResult = "/out/mix";

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "Audio (WAV)…" }));

    await waitFor(() => expect(backend.written.has("/out/mix.wav")).toBe(true));
    const wav = bytesOf("/out/mix.wav");
    expect(text(wav.slice(0, 4))).toBe("RIFF");
    expect(text(wav.slice(8, 12))).toBe("WAVE");
    expect(wav).toHaveLength(44 + 8); // the fake player renders four samples
    expect(player.renderAudio).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled(); // the song's file is unchanged
    expect((await screen.findAllByText("Exported “mix.wav”")).length).toBeGreaterThan(0);
  });

  it("exports the mix as an M4A file through the system encoder", async () => {
    const { user, player, onSaved, calls } = await setup();
    backend.saveResult = "/out/mix";

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "Audio (M4A)…" }));

    await waitFor(() => expect(backend.written.has("/out/mix.m4a")).toBe(true));
    // The WAV the song rendered goes to the encoder (the mock keeps it as it is).
    const sent = bytesOf("/out/mix.m4a");
    expect(text(sent.slice(0, 4))).toBe("RIFF");
    expect(calls.map((c) => c.cmd)).toContain("export_m4a");
    expect(calls.map((c) => c.cmd)).not.toContain("write_score_file");
    const dialog = calls.find((c) => c.cmd === "plugin:dialog|save")!;
    expect(dialog.args).toMatchObject({
      options: {
        title: "Export audio",
        filters: [{ name: "M4A audio (AAC)", extensions: ["m4a"] }],
      },
    });
    expect(player.renderAudio).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect((await screen.findAllByText("Exported “mix.m4a”")).length).toBeGreaterThan(0);
  });

  it("exports M4A from the native menu too", async () => {
    await setup();
    backend.saveResult = "/out/native.m4a";
    await menu("export-audio-m4a");
    await waitFor(() => expect(backend.written.has("/out/native.m4a")).toBe(true));
  });

  it("offers M4A only where the desktop app can encode it", async () => {
    const { user } = await setup();
    mockTauri({ app_info: () => ({ ...APP_INFO, os: "windows" }) });
    // A new window of the same app on Windows: no M4A item.
    const song = await makeSong();
    renderWithProviders(<ScoreWorkspace song={song} onOpen={vi.fn()} onSaved={vi.fn()} />);
    FakeScorePlayer.last.becomeReady();
    const fileButtons = screen.getAllByRole("button", { name: "File" });
    await user.click(fileButtons[fileButtons.length - 1]!);
    await screen.findByRole("menuitem", { name: "Audio (WAV)…" });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Audio (M4A)…" })).toBeNull(),
    );
  });

  it("does not offer M4A in a plain browser", async () => {
    const { user } = await setup({ desktop: false });
    await user.click(screen.getByRole("button", { name: "File" }));
    await screen.findByRole("menuitem", { name: "Audio (WAV)…" });
    expect(screen.queryByRole("menuitem", { name: "Audio (M4A)…" })).not.toBeInTheDocument();
  });

  it("reports an encoder that failed", async () => {
    mockTauri({
      export_m4a: () => {
        throw { kind: "audio", message: "The system's AAC encoder could not start: disk full" };
      },
    });
    const song = await makeSong();
    renderWithProviders(
      <>
        <ScoreWorkspace song={song} onOpen={vi.fn()} onSaved={vi.fn()} />
        <Toaster />
      </>,
    );
    FakeScorePlayer.last.becomeReady();
    backend.saveResult = "/out/mix.m4a";

    await menu("export-audio-m4a");

    expect((await screen.findAllByText("Couldn't export the audio")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/AAC encoder could not start/).length).toBeGreaterThan(0);
  });

  it("starts the WAV export's Save dialog next to the song, and does nothing when cancelled", async () => {
    const { user, player } = await setup({ path: "/songs/practice-song.gp" });
    backend.saveResult = null;

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "Audio (WAV)…" }));

    await waitFor(() => expect(backend.written.size).toBe(0));
    expect(player.renderAudio).not.toHaveBeenCalled();
  });

  it("reports audio that could not be rendered", async () => {
    const { user, player } = await setup();
    backend.saveResult = "/out/mix.wav";
    player.renderAudio.mockRejectedValueOnce(new Error("The instrument sounds are still loading."));

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "Audio (WAV)…" }));

    expect((await screen.findAllByText("Couldn't export the audio")).length).toBeGreaterThan(0);
    expect(screen.getByText("The instrument sounds are still loading.")).toBeInTheDocument();
    expect(backend.written.size).toBe(0);
  });

  it("downloads the WAV file in a plain browser", async () => {
    const createObjectURL = vi.fn(() => "blob:audio");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { user } = await setup({ desktop: false });

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: "Audio (WAV)…" }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect((await screen.findAllByText(/Downloaded “Practice Song.wav”/)).length).toBeGreaterThan(
      0,
    );
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

    await trackAction(user, "Guitar", "Settings…");
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
    await trackAction(user, "Guitar", "Settings…");
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

describe("ScoreWorkspace: settings and the audio track in the song file", () => {
  it("stores the mix inside a saved .gp file", async () => {
    const { user, calls } = await setup({ path: "/songs/practice-song.gp" });
    await edit(user);
    await menu("save");
    await waitFor(() => expect(calls.some((c) => c.cmd === "write_project_settings")).toBe(true));
    const call = calls.find((c) => c.cmd === "write_project_settings")!;
    expect(call.args).toMatchObject({
      path: "/songs/practice-song.gp",
      embedAudio: false,
      settings: expect.objectContaining({ version: 2 }),
    });
  });

  it("does not store settings in Guitar Pro 5 files", async () => {
    const { user, calls } = await setup({ path: "/songs/practice-song.gp5" });
    await edit(user);
    await menu("save");
    await waitFor(() => expect(backend.written.has("/songs/practice-song.gp5")).toBe(true));
    expect(calls.some((c) => c.cmd === "write_project_settings")).toBe(false);
  });

  it("saves the recording as a reference when it cannot be embedded", async () => {
    const embed: boolean[] = [];
    mockTauri({
      write_project_settings: (args) => {
        const { embedAudio } = args as { embedAudio: boolean };
        embed.push(embedAudio);
        if (embedAudio) throw { kind: "audio", message: "The audio track is not loaded." };
        return null;
      },
    });
    const song = await makeSong("/songs/practice-song.gp");
    song.mix = {
      ...song.mix,
      audioTrack: {
        name: "take.mp3",
        embedded: true,
        enabled: true,
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        eq: { lowDb: 0, midDb: 0, midHz: 1000, highDb: 0 },
        semitones: 0,
        cents: 0,
        filter: "off",
        sync: [],
      },
    };
    const { user } = renderWithProviders(
      <>
        <ScoreWorkspace song={song} onOpen={vi.fn()} />
        <Toaster />
      </>,
    );
    FakeScorePlayer.last.becomeReady();
    await edit(user);
    await menu("save");
    await waitFor(() => expect(embed).toEqual([true, false]));
    expect(await toastWith("The recording was not embedded")).toBeInTheDocument();
  });

  it("adds an audio track from the Track menu and edits it", async () => {
    const { user } = await setup({ path: "/songs/practice-song.gp" });
    backend.dialogResult = "/music/take.mp3";
    await menu("add-audio-track");
    const row = await screen.findByTestId("audio-track-row");
    expect(
      within(row).getByRole("button", { name: "Edit the audio track take.mp3" }),
    ).toBeInTheDocument();
    // Without the native engine it waits, and says why.
    expect(
      await toastWith("The audio track plays with the native audio engine"),
    ).toBeInTheDocument();
    const editor = screen.getByRole("region", { name: "Audio track" });
    expect(within(editor).getByTitle("/music/take.mp3")).toHaveTextContent("take.mp3");
    await user.click(within(editor).getByRole("button", { name: "Remove the audio track" }));
    expect(screen.queryByTestId("audio-track-row")).toBeNull();
    await expectNoA11yViolations();
  });

  it("loads the recording when the native engine plays", async () => {
    mockTauri();
    localStorage.setItem("smart-beat:audio-engine", "native");
    const song = await makeSong("/songs/practice-song.gp");
    renderWithProviders(<ScoreWorkspace song={song} onOpen={vi.fn()} />);
    const player = FakeScorePlayer.last;
    player.usesNativeEngine = true;
    player.becomeReady();
    backend.dialogResult = "/music/take.wav";
    await menu("add-audio-track");
    await waitFor(() =>
      expect(player.loadBacking).toHaveBeenCalledWith({ type: "file", path: "/music/take.wav" }),
    );
    expect(await screen.findByTestId("audio-waveform")).toBeInTheDocument();
  });

  it("refuses files that are not audio", async () => {
    await setup();
    backend.dialogResult = "/music/notes.txt";
    await menu("add-audio-track");
    expect(
      await toastWith("“notes.txt” is not an audio file Smart Beat opens"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("audio-track-row")).toBeNull();
  });

  it("adds a monitor track that plays the input chosen in Settings through its own pedalboard", async () => {
    mockTauri();
    localStorage.setItem("smart-beat:audio-engine", "native");
    storeAudioInput({ deviceId: "scarlett", label: "Scarlett 2i2 USB" });
    storeAudioInputChannel(1);
    const song = await makeSong("/songs/practice-song.gp");
    const { user } = renderWithProviders(
      <>
        <ScoreWorkspace song={song} onOpen={vi.fn()} />
        <Toaster />
      </>,
    );
    const player = FakeScorePlayer.last;
    player.usesNativeEngine = true;
    player.becomeReady();
    expect(player.options.monitorInput).toEqual({ device: "Scarlett 2i2 USB", channel: 1 });

    await user.click(screen.getByRole("button", { name: "Add monitor track" }));
    const row = await screen.findByTestId("monitor-track-row");
    expect(await toastWith("The monitor track plays your audio input live")).toBeInTheDocument();
    expect(player.setMix).toHaveBeenLastCalledWith(
      expect.objectContaining({ monitor: expect.objectContaining({ enabled: true }) }),
    );
    player.emit("onMonitorStatus", {
      open: true,
      device: "Scarlett 2i2 USB",
      channels: 2,
      sampleRate: 48_000,
      latencyMs: 7,
      error: null,
    });
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Scarlett 2i2 USB · input 2 · about 7 ms delay",
    );

    // The same pedalboard as the tracks, for the monitor track.
    await user.click(within(row).getByRole("button", { name: "Actions for the monitor track" }));
    await user.click(await screen.findByRole("menuitem", { name: "Effects (pedalboard)…" }));
    const board = await screen.findByRole("dialog", { name: "Pedalboard: Monitor" });
    expect(within(board).queryByRole("button", { name: "Add sound" })).toBeNull();
    await user.click(within(board).getByRole("button", { name: "Add Delay" }));
    expect(within(board).getAllByTestId("effect-block")).toHaveLength(1);
    expect(player.setMix.mock.lastCall![0].monitor.effects).toHaveLength(1);
    await user.keyboard("{Escape}");

    // Another channel chosen in Settings goes to the player.
    act(() => storeAudioInputChannel(0));
    expect(player.setMonitorInput).toHaveBeenLastCalledWith({
      device: "Scarlett 2i2 USB",
      channel: 0,
    });

    await user.click(within(row).getByRole("button", { name: "Actions for the monitor track" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(screen.queryByTestId("monitor-track-row")).toBeNull();
    expect(player.setMix.mock.lastCall![0]).not.toHaveProperty("monitor");
  });

  it("sets up live monitoring in Practice mix and keeps the rig when switching playback or listening off", async () => {
    mockTauri();
    const onOpenSettings = vi.fn();
    rememberMonitorTrack({ ...DEFAULT_MONITOR, volume: 0.4, effects: [defaultEffect("delay")] });
    const song = await makeSong("/songs/practice-song.gp");
    const { user } = renderWithProviders(
      <ScoreWorkspace song={song} onOpen={vi.fn()} onOpenSettings={onOpenSettings} />,
    );
    FakeScorePlayer.last.becomeReady();
    await user.click(screen.getByRole("button", { name: /^Practice mix/ }));
    const popup = await screen.findByRole("dialog", { name: "Practice mix" });
    expect(within(popup).getByRole("button", { name: "Input effects…" })).toBeDisabled();
    await user.click(within(popup).getByRole("switch", { name: "Monitor my input" }));
    expect(localStorage.getItem("smart-beat:audio-engine")).toBe("native");
    const player = FakeScorePlayer.last;
    player.becomeReady();
    const rig = player.options.mix.monitor;
    expect(rig).toMatchObject({ enabled: true, volume: 0.4, effects: [defaultEffect("delay")] });
    await user.click(within(popup).getByRole("radio", { name: /Backing only/ }));
    expect(player.setMix.mock.lastCall![0]).toMatchObject({ focusMode: "backing", monitor: rig });
    await user.click(within(popup).getByRole("radio", { name: /Hear only this track/ }));
    expect(player.setMix.mock.lastCall![0]).toMatchObject({ focusMode: "onlyMe", monitor: rig });
    await user.click(within(popup).getByRole("switch", { name: "Monitor my input" }));
    expect(player.setMix.mock.lastCall![0].monitor).toEqual({ ...rig, enabled: false });
    await user.click(within(popup).getByRole("switch", { name: "Monitor my input" }));
    expect(player.setMix.mock.lastCall![0].monitor).toEqual(rig);
    await expectNoA11yViolations();
    await user.click(within(popup).getByRole("button", { name: "Input settings…" }));
    expect(onOpenSettings).toHaveBeenCalledWith(expect.any(HTMLElement));
    await user.click(within(popup).getByRole("button", { name: "Input effects…" }));
    const board = await screen.findByRole("dialog", { name: "Pedalboard: Monitor" });
    expect(within(board).getAllByTestId("effect-block")).toHaveLength(1);
  });

  it("enables native playback from the mixer monitor switch", async () => {
    mockTauri();
    const song = await makeSong();
    song.mix = { ...song.mix, monitor: { ...DEFAULT_MONITOR, enabled: false } };
    const { user } = renderWithProviders(<ScoreWorkspace song={song} onOpen={vi.fn()} />);
    const row = await screen.findByTestId("monitor-track-row");
    const toggle = within(row).getByRole("switch", {
      name: "Monitor track on (listen to the input)",
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(localStorage.getItem("smart-beat:audio-engine")).toBe("native");
    expect(FakeScorePlayer.last.options.mix.monitor).toMatchObject({ enabled: true });
  });

  it("starts a new monitor track from the last one, so the rig comes along", async () => {
    mockTauri();
    rememberMonitorTrack({ ...DEFAULT_MONITOR, volume: 0.4, effects: [defaultEffect("delay")] });
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Add monitor track" }));
    expect(localStorage.getItem("smart-beat:audio-engine")).toBe("native");
    expect(await toastWith("The monitor track plays your audio input live")).toBeInTheDocument();
    const row = await screen.findByTestId("monitor-track-row");
    expect(within(row).getByRole("slider", { name: "Volume, monitor track" })).toHaveAttribute(
      "aria-valuetext",
      "40%",
    );
  });

  it("opens the drum mixer and the pedalboard from a track's menu", async () => {
    const { user } = await setup();
    await trackAction(user, "Drums", "Drum mixer…");
    const drums = await screen.findByRole("dialog", { name: "Drum mixer: Drums" });
    await user.click(within(drums).getByRole("button", { name: "Mute Snare" }));
    await user.click(within(drums).getByRole("button", { name: "Done" }));
    await trackAction(user, "Guitar", "Effects (pedalboard)…");
    const board = await screen.findByRole("dialog", { name: "Pedalboard: Guitar" });
    await user.click(within(board).getByRole("button", { name: "Add sound" }));
    expect(within(board).getByRole("combobox", { name: "Sound" })).toHaveTextContent("Sound 2");
    await user.click(within(board).getByRole("button", { name: "Add Delay" }));
    expect(within(board).getAllByTestId("effect-block")).toHaveLength(1);
    expect(within(board).getByRole("region", { name: "Sound automation" })).toBeInTheDocument();
  });
});
