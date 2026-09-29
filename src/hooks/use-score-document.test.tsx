import { act, renderHook, screen, waitFor } from "@testing-library/react";

import { Toaster } from "@/components/ui/sonner";
import { firstScoreFile, useScoreDocument } from "@/hooks/use-score-document";
import { fileKey } from "@/lib/score/format";
import { mixFromScore } from "@/lib/score/mixer";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes, SUMMARY } from "@/test/score";
import { backend, mockTauri } from "@/test/tauri";

const SONG = "/songs/practice-song.gp";

function setup() {
  renderWithProviders(<Toaster />);
  return renderHook(() => useScoreDocument());
}

describe("useScoreDocument in the desktop app", () => {
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

  it("gives each open a new id, even for the same file", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    const { result } = setup();

    await act(() => result.current.openPath(SONG));
    const first = result.current.song!.id;
    await act(() => result.current.openPath(SONG));

    expect(result.current.song!.id).toBeGreaterThan(first);
  });

  it("explains why a file can't be opened and keeps the current song", async () => {
    mockTauri();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.files.set("/songs/corrupt.gp5", fixtureBytes("corrupt.gp5"));
    const { result } = setup();
    await act(() => result.current.openPath(SONG));

    await act(() => result.current.openPath("/songs/corrupt.gp5"));

    expect(await screen.findByText("Couldn't open “corrupt.gp5”")).toBeInTheDocument();
    expect(screen.getByText(/damaged or uses a Guitar Pro version/)).toBeInTheDocument();
    expect(result.current.song?.name).toBe("practice-song.gp");
  });

  it("reports errors from the Rust core", async () => {
    mockTauri();
    const { result } = setup();

    await act(() => result.current.openPath("/songs/gone.gp"));

    expect(await screen.findByText(/could not be found/)).toBeInTheDocument();
    expect(result.current.song).toBeNull();
  });

  it("ignores a file that finishes loading after a newer one", async () => {
    let release: (bytes: ArrayBuffer) => void = () => {};
    mockTauri({
      read_score_file: (args) =>
        (args as { path: string }).path === "/slow.gp"
          ? new Promise((resolve) => (release = resolve))
          : fixtureBytes("practice-song.gp").slice().buffer,
    });
    const { result } = setup();

    let slow: Promise<void> = Promise.resolve();
    act(() => {
      slow = result.current.openPath("/slow.gp");
    });
    await act(() => result.current.openPath("/fast.gp"));
    await act(async () => {
      release(fixtureBytes("practice-song.gp").slice().buffer);
      await slow;
    });

    expect(result.current.song?.name).toBe("fast.gp");
  });
});

describe("useScoreDocument in a browser", () => {
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

    expect(await screen.findByText(/opens Guitar Pro files/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.song).toBeNull());
  });
});

describe("firstScoreFile", () => {
  it("prefers a Guitar Pro file, or falls back to the first item", () => {
    const name = (s: string) => s;
    expect(firstScoreFile(["a.txt", "b.gp5", "c.gp"], name)).toBe("b.gp5");
    expect(firstScoreFile(["a.txt", "b.pdf"], name)).toBe("a.txt");
    expect(firstScoreFile([], name)).toBeUndefined();
  });
});
