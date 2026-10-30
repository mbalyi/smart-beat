import { emit } from "@tauri-apps/api/event";

import {
  acceptUmxTerms,
  cancelStemSeparation,
  cancelUmxDownload,
  clearStemSongs,
  deleteStemSong,
  downloadUmxModel,
  isStemsStopped,
  listStemSongs,
  NotInDesktopAppError,
  pickStemFile,
  readStem,
  removeUmxModel,
  renderStemMix,
  separateStems,
  STEMS_STOPPED,
  stemCacheInfo,
  umxModelStatus,
  type SeparateRequest,
  type StemProgress,
} from "@/lib/tauri";
import { backend, mockTauri, STEM_SONG } from "@/test/tauri";

const REQUEST: SeparateRequest = {
  path: "/Music/song.mp3",
  kinds: ["drums", "bass"],
  engine: "fast",
  strongDrums: true,
};

describe("stem separation outside the desktop app", () => {
  it("cannot separate, list or play, and says so", async () => {
    await expect(separateStems(REQUEST)).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(listStemSongs()).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(readStem("a", "drums")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(renderStemMix("a", {}, 0.5)).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(umxModelStatus()).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(pickStemFile()).rejects.toBeInstanceOf(NotInDesktopAppError);
  });

  it("has nothing to cancel", async () => {
    await expect(cancelStemSeparation()).resolves.toBeUndefined();
    await expect(cancelUmxDownload()).resolves.toBeUndefined();
  });
});

describe("stem separation commands", () => {
  it("sends the request as given and returns the song", async () => {
    const calls = mockTauri({ stems_separate: () => STEM_SONG });
    await expect(separateStems(REQUEST)).resolves.toEqual(STEM_SONG);
    expect(calls).toContainEqual({ cmd: "stems_separate", args: { request: REQUEST } });
  });

  it("reports the progress events of the job", async () => {
    mockTauri({
      stems_separate: async () => {
        await emit("stems-progress", { stage: "reading", fraction: 0.5 });
        await emit("stems-progress", { stage: "separating", fraction: 0.25 });
        return STEM_SONG;
      },
    });
    const seen: StemProgress[] = [];
    await separateStems(REQUEST, (progress) => seen.push(progress));
    expect(seen).toEqual([
      { stage: "reading", fraction: 0.5 },
      { stage: "separating", fraction: 0.25 },
    ]);
  });

  it("recognises the error of a stopped job", async () => {
    mockTauri({
      stems_separate: () => {
        throw { kind: "audio", message: STEMS_STOPPED };
      },
    });
    const error = await separateStems(REQUEST).catch((cause: unknown) => cause);
    expect(isStemsStopped(error)).toBe(true);
    expect(isStemsStopped(STEMS_STOPPED)).toBe(true);
    expect(isStemsStopped(new Error("The file is damaged."))).toBe(false);
    expect(isStemsStopped(null)).toBe(false);
  });

  it("lists, measures, deletes and clears the library", async () => {
    const calls = mockTauri({ stems_clear: () => 190_000_000 });
    backend.stemSongs = [STEM_SONG];
    await expect(listStemSongs()).resolves.toEqual([STEM_SONG]);
    await expect(stemCacheInfo()).resolves.toEqual({
      bytes: STEM_SONG.bytes,
      count: 1,
      limitBytes: 2 * 1024 ** 3,
    });
    await deleteStemSong(STEM_SONG.id);
    await expect(listStemSongs()).resolves.toEqual([]);
    await expect(clearStemSongs()).resolves.toBe(190_000_000);
    expect(calls).toContainEqual({ cmd: "stems_delete", args: { id: STEM_SONG.id } });
  });

  it("reads one stem and asks for a slowed mix with the gains", async () => {
    const wav = new Uint8Array([82, 73, 70, 70]).buffer;
    const calls = mockTauri({ stems_read: () => wav, stems_render_mix: () => wav });
    await expect(readStem("abc", "bass")).resolves.toBeDefined();
    await renderStemMix("abc", { drums: 0, bass: 0.5 }, 0.8);
    expect(calls).toContainEqual({ cmd: "stems_read", args: { id: "abc", kind: "bass" } });
    expect(calls).toContainEqual({
      cmd: "stems_render_mix",
      args: { id: "abc", request: { gains: { drums: 0, bass: 0.5 }, speed: 0.8 } },
    });
  });

  it("opens the native dialog for an audio file", async () => {
    const calls = mockTauri();
    backend.dialogResult = "/Music/song.flac";
    await expect(pickStemFile()).resolves.toBe("/Music/song.flac");
    expect(calls).toContainEqual({
      cmd: "plugin:dialog|open",
      args: {
        options: expect.objectContaining({
          multiple: false,
          directory: false,
          filters: [{ name: "Audio files", extensions: expect.arrayContaining(["mp3", "aiff"]) }],
        }),
      },
    });
  });
});

describe("the neural model commands", () => {
  it("reads the status and records the terms", async () => {
    mockTauri();
    await expect(umxModelStatus()).resolves.toMatchObject({
      downloaded: false,
      downloadBytes: 142_551_184,
    });
    await acceptUmxTerms();
    expect((await umxModelStatus()).termsAccepted).toBe(true);
  });

  it("reports the download progress", async () => {
    mockTauri({
      umx_model_download: async () => {
        await emit("umx-model-download-progress", { downloadedBytes: 10, totalBytes: 40 });
        return null;
      },
    });
    const seen: unknown[] = [];
    await downloadUmxModel((progress) => seen.push(progress));
    expect(seen).toEqual([{ downloadedBytes: 10, totalBytes: 40 }]);
  });

  it("cancels and removes the model", async () => {
    const calls = mockTauri({ umx_model_remove: () => null });
    await cancelUmxDownload();
    await removeUmxModel();
    expect(calls.map((call) => call.cmd)).toEqual(["umx_model_cancel", "umx_model_remove"]);
  });
});
