import { act, renderHook, screen, waitFor } from "@testing-library/react";

import { Toaster } from "@/components/ui/sonner";
import { firstScoreFile, useScoreDocuments } from "@/hooks/use-score-document";
import { fileKey } from "@/lib/score/format";
import { mixFromScore } from "@/lib/score/mixer";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes, SUMMARY } from "@/test/score";
import { exportScore } from "@/lib/export";
import { texScore } from "@/test/playback";
import { backend, mockTauri } from "@/test/tauri";

const SONG = "/songs/practice-song.gp";

function setup() {
  renderWithProviders(<Toaster />);
  return renderHook(() => useScoreDocuments());
}

describe("useScoreDocuments in the desktop app", () => {
  it("opens a song from a path with the mix from the file", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();

    await act(() => result.current.openPath(SONG));

    const song = result.current.song!;
    expect(song.name).toBe("practice-song.gp");
    expect(song.summary).toEqual(SUMMARY);
    expect(song.fileKey).toBe(await fileKey(fixtureBytes("practice-song.gp")));
    expect(song.mix).toEqual(mixFromScore(SUMMARY));
    expect(song.score.tracks).toHaveLength(4);
  });

  it("starts from the mix saved for the song", async () => {
    mockTauri();
    const bytes = fixtureBytes("practice-song.gp");
    backend.files.set(SONG, bytes);
    const saved = { ...mixFromScore(SUMMARY), master: 0.25 };
    backend.mixes.set(await fileKey(bytes), saved);
    const { result } = setup();

    await act(() => result.current.openPath(SONG));

    expect(result.current.song?.mix).toEqual(saved);
  });

  it("still opens the song if the saved mix can't be read", async () => {
    mockTauri({
      load_mixer_settings: () => {
        throw { kind: "io", message: "disk error" };
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();

    await act(() => result.current.openPath(SONG));

    expect(result.current.song?.mix).toEqual(mixFromScore(SUMMARY));
  });

  it("opens each song in its own tab and shows the newest", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.files.set("/songs/other.gp", fixtureBytes("practice-song.gp"));
    const { result } = setup();

    await act(() => result.current.openPath(SONG));
    const first = result.current.song!.id;
    await act(() => result.current.openPath("/songs/other.gp"));

    expect(result.current.songs.map((s) => s.name)).toEqual(["practice-song.gp", "other.gp"]);
    expect(result.current.song!.id).toBeGreaterThan(first);
  });

  it("shows the tab of a song that is already open instead of opening it twice", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.files.set("/songs/other.gp", fixtureBytes("practice-song.gp"));
    const { result } = setup();
    await act(() => result.current.openPath(SONG));
    const first = result.current.song!.id;
    await act(() => result.current.openPath("/songs/other.gp"));

    await act(() => result.current.openPath(SONG));

    expect(result.current.songs).toHaveLength(2);
    expect(result.current.song!.id).toBe(first);
  });

  it("switches between tabs and closes them, showing the neighbour", async () => {
    mockTauri();
    backend.files.set("/a.gp", fixtureBytes("practice-song.gp"));
    backend.files.set("/b.gp", fixtureBytes("practice-song.gp"));
    backend.files.set("/c.gp", fixtureBytes("practice-song.gp"));
    const { result } = setup();
    await act(() => result.current.openPath("/a.gp"));
    await act(() => result.current.openPath("/b.gp"));
    await act(() => result.current.openPath("/c.gp"));
    const [a, b, c] = result.current.songs.map((s) => s.id) as [number, number, number];

    act(() => result.current.activate(b));
    expect(result.current.song?.name).toBe("b.gp");

    act(() => result.current.close(b)); // the next tab takes over
    expect(result.current.song?.id).toBe(c);
    act(() => result.current.close(a)); // a hidden tab: the shown one stays
    expect(result.current.song?.id).toBe(c);
    act(() => result.current.close(c));
    expect(result.current.song).toBeNull();
    expect(result.current.songs).toEqual([]);
  });

  it("explains why a file can't be opened and keeps the current song", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.files.set("/songs/corrupt.gp5", fixtureBytes("corrupt.gp5"));
    const { result } = setup();
    await act(() => result.current.openPath(SONG));

    await act(() => result.current.openPath("/songs/corrupt.gp5"));

    expect(await screen.findByText("Couldn't open “corrupt.gp5”")).toBeInTheDocument();
    expect(screen.getByText(/damaged or is in a format Smart Beat can't read/)).toBeInTheDocument();
    expect(result.current.song?.name).toBe("practice-song.gp");
  });

  it("reports errors from the Rust core", async () => {
    mockTauri();
    const { result } = setup();

    await act(() => result.current.openPath("/songs/gone.gp"));

    expect((await screen.findAllByText(/could not be found/)).length).toBeGreaterThan(0);
    expect(result.current.song).toBeNull();
  });

  it("keeps every song whichever one finishes loading first", async () => {
    let release: (bytes: ArrayBuffer) => void = () => {};
    mockTauri({
      read_score_file: (args) =>
        (args as { path: string }).path === "/slow.gp"
          ? new Promise((resolve) => (release = resolve))
          : fixtureBytes("practice-song.gp").slice().buffer,
    });
    const { result } = setup();

    let slow: Promise<boolean> = Promise.resolve(false);
    act(() => {
      slow = result.current.openPath("/slow.gp");
    });
    await act(() => result.current.openPath("/fast.gp"));
    await act(async () => {
      release(fixtureBytes("practice-song.gp").slice().buffer);
      await slow;
    });

    expect(result.current.songs.map((s) => s.name).sort()).toEqual(["fast.gp", "slow.gp"]);
  });
});

describe("useScoreDocuments in a browser", () => {
  it("opens a dropped or picked File without saved settings", async () => {
    const { result } = setup();
    const bytes = fixtureBytes("practice-song.gp");
    const file = new File([bytes.slice()], "song.gp");

    await act(() => result.current.openFile(file));

    expect(result.current.song?.name).toBe("song.gp");
    expect(result.current.song?.mix).toEqual(mixFromScore(SUMMARY));
  });

  it("refuses other file types before reading them", async () => {
    const { result } = setup();
    const file = new File(["%PDF"], "notes.pdf");
    const read = vi.spyOn(file, "arrayBuffer");

    await act(() => result.current.openFile(file));

    expect(
      await screen.findByText(/opens Guitar Pro, MusicXML, MIDI, MuseScore/),
    ).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.song).toBeNull());
  });
});

describe("firstScoreFile", () => {
  it("prefers a Guitar Pro file, or falls back to the first item", () => {
    const name = (s: string) => s;
    expect(firstScoreFile(["a.pdf", "b.gp5", "c.gp"], name)).toBe("b.gp5");
    expect(firstScoreFile(["a.pdf", "b.zip"], name)).toBe("a.pdf");
    expect(firstScoreFile([], name)).toBeUndefined();
  });
});

describe("useScoreDocuments: recent files and saving", () => {
  it("remembers a song opened from a path, with its path", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();

    await act(() => result.current.openPath(SONG));

    expect(result.current.song?.path).toBe(SONG);
    expect(backend.recent).toEqual([SONG]);
  });

  it("forgets a file that is gone, and keeps the ones it could open", async () => {
    mockTauri();
    backend.recent = ["/gone.gp", SONG];
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();

    await act(() => result.current.openPath("/gone.gp"));

    expect(backend.recent).toEqual([SONG]);
    expect((await screen.findAllByText(/could not be found/)).length).toBeGreaterThan(0);
  });

  it("does not forget a file that failed for another reason", async () => {
    mockTauri();
    backend.recent = [SONG];
    backend.files.set(SONG, new Uint8Array([70, 70, 70]));
    const { result } = setup();

    await act(() => result.current.openPath(SONG));

    expect(backend.recent).toEqual([SONG]);
  });

  it("still opens the song if the recent list can't be updated", async () => {
    mockTauri({
      add_recent_file: () => {
        throw { kind: "io", message: "disk error" };
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();

    await act(() => result.current.openPath(SONG));

    expect(result.current.song?.name).toBe("practice-song.gp");
  });

  it("has no path for new songs or browser files", async () => {
    const { result } = setup();
    await act(() => result.current.newSong());
    expect(result.current.song?.path).toBeNull();
    await act(() =>
      result.current.openFile(new File([fixtureBytes("practice-song.gp").slice()], "s.gp")),
    );
    expect(result.current.song?.path).toBeNull();
  });

  it("opens MIDI and MusicXML as converted songs that are never overwritten by a save", async () => {
    mockTauri();
    const source = texScore(
      String.raw`\track "G" \staff {score tabs} \instrument 25 :4 3.6 5.6 7.6 5.6`,
    );
    backend.files.set("/songs/riff.mid", exportScore(source, "midi").bytes);
    backend.files.set("/songs/riff.musicxml", exportScore(source, "musicxml").bytes);
    const { result } = setup();

    await act(() => result.current.openPath("/songs/riff.mid"));
    expect(result.current.song).toMatchObject({
      name: "riff.mid",
      path: null,
      sourceName: "riff.mid",
    });
    expect(await screen.findByText("“riff.mid” was converted")).toBeInTheDocument();
    expect(backend.recent).toEqual(["/songs/riff.mid"]);

    await act(() => result.current.openPath("/songs/riff.musicxml"));
    expect(result.current.song).toMatchObject({ name: "riff.musicxml", path: null });
  });

  it("follows a save: new name, path and content key, same song", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();
    await act(() => result.current.openPath(SONG));
    const id = result.current.song!.id;

    act(() =>
      result.current.markSaved(id, { name: "copy.gp", path: "/songs/copy.gp", fileKey: "k" }),
    );

    expect(result.current.song).toMatchObject({
      id,
      name: "copy.gp",
      path: "/songs/copy.gp",
      fileKey: "k",
      isNew: false,
    });
  });
});

describe("generated MIDI imports", () => {
  it("opens a new score with the audio filename as title", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();
    await act(() => result.current.openPath(SONG));
    const source = texScore(
      String.raw`\track "G" \staff {score tabs} \instrument 25 :4 3.6 5.6 7.6 5.6`,
    );
    const midi = exportScore(source, "midi").bytes.slice();
    let opened = false;
    await act(async () => {
      opened = await result.current.openFile(new File([midi], "my-recording.mid"), "my-recording");
    });
    expect(opened).toBe(true);
    expect(result.current.songs).toHaveLength(2);
    expect(result.current.song?.summary.title).toBe("my-recording");
    expect(result.current.song?.score.title).toBe("my-recording");
  });
  it("reports failed import and preserves the active score", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();
    await act(() => result.current.openPath(SONG));
    const active = result.current.song!.id;
    let opened = true;
    await act(async () => {
      opened = await result.current.openFile(new File(["corrupt"], "generated.mid"));
    });
    expect(opened).toBe(false);
    expect(result.current.song!.id).toBe(active);
    expect(result.current.songs).toHaveLength(1);
  });
});

describe("useScoreDocuments: a score made in memory", () => {
  it("opens it as an unsaved song with its own tab", async () => {
    const { createSong } = await import("@/lib/score/tracks");
    const { result } = setup();
    const score = createSong();

    await act(() => result.current.openScore(score, "Recording"));

    const song = result.current.song!;
    expect(song.name).toBe("Recording");
    expect(song.score).toBe(score);
    expect(song.unsaved).toBe(true);
    expect(song.path).toBeNull();
    expect(song.fileKey).toBeNull();
    expect(song.summary.tracks).toHaveLength(1);
    expect(result.current.songs).toHaveLength(1);
  });
});

describe("useScoreDocuments: settings inside .gp files", () => {
  it("prefers the settings stored in the song file", async () => {
    mockTauri();
    const bytes = fixtureBytes("practice-song.gp");
    backend.files.set(SONG, bytes);
    backend.mixes.set(await fileKey(bytes), { ...mixFromScore(SUMMARY), master: 0.25 });
    const inFile = { ...mixFromScore(SUMMARY), master: 0.6, masterPan: -0.5 };
    backend.projectSettings.set(SONG, inFile);
    const { result } = setup();
    await act(() => result.current.openPath(SONG));
    expect(result.current.song?.mix).toEqual(inFile);
  });

  it("falls back to the app's settings when the file has none or can't be read", async () => {
    mockTauri({
      read_project_settings: () => {
        throw { kind: "io", message: "broken" };
      },
    });
    const bytes = fixtureBytes("practice-song.gp");
    backend.files.set(SONG, bytes);
    const saved = { ...mixFromScore(SUMMARY), master: 0.25 };
    backend.mixes.set(await fileKey(bytes), saved);
    const { result } = setup();
    await act(() => result.current.openPath(SONG));
    expect(result.current.song?.mix).toEqual(saved);
  });
});

describe("useScoreDocuments: cloud items (#187)", () => {
  const ITEM = "drive:abc";

  it("opens a cloud item through openPath and remembers its id", async () => {
    mockTauri({ cloud_read: () => fixtureBytes("practice-song.gp").slice().buffer });
    const { result } = setup();

    await act(() => result.current.openPath(ITEM));

    expect(result.current.song?.path).toBe(ITEM);
    expect(backend.recent).toEqual([ITEM]);
  });

  it.each([
    ["network", /can't be reached/],
    ["auth-expired", /Reconnect Google Drive in Settings/],
  ])("keeps a recent cloud item that fails with %s", async (kind, message) => {
    mockTauri({
      cloud_read: () => {
        throw { kind, message: "x" };
      },
    });
    backend.recent = [ITEM];
    const { result } = setup();

    await act(() => result.current.openPath(ITEM));

    expect(backend.recent).toEqual([ITEM]);
    expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
  });
});
