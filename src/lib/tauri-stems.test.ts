import { emit } from "@tauri-apps/api/event";

import {
  acceptStemModelTerms,
  acceptUmxTerms,
  cancelStemModelDownload,
  cancelStemSeparation,
  cancelUmxDownload,
  clearStemSongs,
  deleteStemSong,
  detectStemTempo,
  downloadStemModel,
  downloadUmxModel,
  estimateStemBundle,
  isStemFileStopped,
  isStemsStopped,
  listCloudStemFiles,
  listCloudStems,
  listStemSongs,
  NotInDesktopAppError,
  onStemBundleOpened,
  openStemBundle,
  openStemBundleFromCloud,
  pickStemBundle,
  pickStemBundleDestination,
  pickStemFile,
  pinStemSong,
  readStem,
  removeStemModel,
  removeUmxModel,
  renderStemMix,
  revealInFolder,
  saveStemBundle,
  saveStemBundleToCloud,
  separateStems,
  STEMS_STOPPED,
  stemCacheInfo,
  stemModelStatus,
  stemsCloudSavePath,
  touchStemSong,
  umxModelStatus,
  type BundleProgress,
  type SeparateRequest,
  type StemProgress,
  type StemTempo,
} from "@/lib/tauri";
import { backend, emitStemBundleOpened, mockTauri, STEM_SONG, STEM_TEMPO } from "@/test/tauri";

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
    await expect(stemModelStatus("htdemucs")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(downloadStemModel("scnet")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(pickStemFile()).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(
      saveStemBundle({ id: "a", dest: "/x.sbstems", includeOriginal: true }),
    ).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(openStemBundle("/x.sbstems")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(touchStemSong("a")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(pinStemSong("a", true)).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(pickStemBundle()).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(pickStemBundleDestination("Song")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(revealInFolder("/x.sbstems")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(stemsCloudSavePath("Song")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(estimateStemBundle("a", true)).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(detectStemTempo("a")).rejects.toBeInstanceOf(NotInDesktopAppError);
  });

  it("lists no cloud stems", async () => {
    await expect(listCloudStems()).resolves.toEqual([]);
  });

  it("has no file to be told about", async () => {
    const stop = await onStemBundleOpened(() => {});
    expect(stop).toBeTypeOf("function");
    expect(() => stop()).not.toThrow();
  });

  it("has nothing to cancel", async () => {
    await expect(cancelStemSeparation()).resolves.toBeUndefined();
    await expect(cancelUmxDownload()).resolves.toBeUndefined();
    await expect(cancelStemModelDownload()).resolves.toBeUndefined();
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

  it("asks for the tempo of a song and gets the fields the page needs", async () => {
    const calls = mockTauri();
    await expect(detectStemTempo("abc")).resolves.toEqual(STEM_TEMPO);
    expect(calls).toContainEqual({ cmd: "stems_detect_tempo", args: { id: "abc" } });

    const changing: StemTempo = {
      bpm: 140,
      confidence: 0.7,
      firstBeatSec: 0.25,
      alternatives: [70],
      steady: false,
      sections: [
        { startSec: 0, endSec: 30, bpm: 100 },
        { startSec: 30, endSec: 70, bpm: 140 },
      ],
    };
    backend.stemTempo = changing;
    await expect(detectStemTempo("abc")).resolves.toEqual(changing);
  });

  it("passes a stopped or failed tempo analysis on as the app's error", async () => {
    mockTauri({
      stems_detect_tempo: () => {
        throw { kind: "audio", message: "Tempo detection stopped." };
      },
    });
    await expect(detectStemTempo("abc")).rejects.toMatchObject({
      message: "Tempo detection stopped.",
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

describe("the SCNet and HTDemucs model commands", () => {
  it("reads the status of the model asked for and records its terms", async () => {
    const calls = mockTauri();
    await expect(stemModelStatus("htdemucs")).resolves.toMatchObject({
      model: "htdemucs",
      downloaded: false,
      available: true,
      downloadBytes: 176_589_623,
    });
    await acceptStemModelTerms("htdemucs");
    expect((await stemModelStatus("htdemucs")).termsAccepted).toBe(true);
    expect((await stemModelStatus("scnet")).termsAccepted).toBe(false);
    expect(calls).toContainEqual({ cmd: "stem_model_accept_terms", args: { model: "htdemucs" } });
  });

  it("reports a model that is not published yet", async () => {
    mockTauri({
      stem_model_status: () => ({ ...backend.stemModels["scnet-xl"], available: false }),
    });
    await expect(stemModelStatus("scnet-xl")).resolves.toMatchObject({ available: false });
  });

  it("reads the 6-part model, which is hosted and about 116 MB", async () => {
    const calls = mockTauri({ stem_model_download: () => null });
    await expect(stemModelStatus("htdemucs-6s")).resolves.toMatchObject({
      model: "htdemucs-6s",
      downloaded: false,
      available: true,
      downloadBytes: 116_246_052,
    });
    expect(calls).toContainEqual({ cmd: "stem_model_status", args: { model: "htdemucs-6s" } });
    await downloadStemModel("htdemucs-6s");
    expect(calls).toContainEqual({ cmd: "stem_model_download", args: { model: "htdemucs-6s" } });
  });

  it("passes the model to the download and reports only its progress", async () => {
    const calls = mockTauri({
      stem_model_download: async () => {
        await emit("stem-model-download-progress", {
          model: "scnet",
          downloadedBytes: 30,
          totalBytes: 40,
        });
        await emit("stem-model-download-progress", {
          model: "htdemucs",
          downloadedBytes: 10,
          totalBytes: 40,
        });
        return null;
      },
    });
    const seen: unknown[] = [];
    await downloadStemModel("htdemucs", (progress) => seen.push(progress));
    expect(calls).toContainEqual({ cmd: "stem_model_download", args: { model: "htdemucs" } });
    expect(seen).toEqual([{ model: "htdemucs", downloadedBytes: 10, totalBytes: 40 }]);
  });

  it("cancels the download and removes a model", async () => {
    const calls = mockTauri({ stem_model_remove: () => null });
    await cancelStemModelDownload();
    await removeStemModel("scnet-xl");
    expect(calls.map((call) => call.cmd)).toEqual(["stem_model_cancel", "stem_model_remove"]);
    expect(calls[1]?.args).toEqual({ model: "scnet-xl" });
  });
});

describe("saved stems (.sbstems)", () => {
  it("saves with the request as given, reports the progress and returns the result", async () => {
    const calls = mockTauri({
      stems_save_bundle: async () => {
        await emit("stems-bundle-progress", { stage: "writing", fraction: 0.4 });
        await emit("stems-bundle-progress", { stage: "writing", fraction: 1 });
        return { path: "/Music/Neon.sbstems", bytes: 9, originalIncluded: false };
      },
    });
    const seen: BundleProgress[] = [];
    const request = { id: "abc", dest: "/Music/Neon.sbstems", includeOriginal: true };
    await expect(saveStemBundle(request, (progress) => seen.push(progress))).resolves.toEqual({
      path: "/Music/Neon.sbstems",
      bytes: 9,
      originalIncluded: false,
    });
    expect(calls).toContainEqual({ cmd: "stems_save_bundle", args: { request } });
    expect(seen).toEqual([
      { stage: "writing", fraction: 0.4 },
      { stage: "writing", fraction: 1 },
    ]);
  });

  it("opens a file and returns its song", async () => {
    const calls = mockTauri();
    const opened = await openStemBundle("/Music/Neon.sbstems");
    expect(opened).toMatchObject({ name: "Opened Song", savedPath: "/Music/Neon.sbstems" });
    expect(calls).toContainEqual({
      cmd: "stems_open_bundle",
      args: { path: "/Music/Neon.sbstems" },
    });
  });

  it("lists the .sbstems files of the cloud folder", async () => {
    const calls = mockTauri();
    backend.cloudStems = [
      {
        name: "Neon.sbstems",
        path: "/Dropbox/Neon.sbstems",
        size: 9,
        modified_ms: 1,
        placeholder: true,
      },
    ];
    await expect(listCloudStems()).resolves.toEqual(backend.cloudStems);
    expect(calls).toContainEqual({ cmd: "list_cloud_stems", args: {} });
  });

  it("asks for a save path in the cloud folder by the song name", async () => {
    const calls = mockTauri();
    backend.cloudFolder = "/Dropbox";
    await expect(stemsCloudSavePath("Neon Nights")).resolves.toBe("/Dropbox/Neon Nights.sbstems");
    expect(calls).toContainEqual({ cmd: "stems_cloud_save_path", args: { name: "Neon Nights" } });
  });

  it("rejects with not-found when no cloud folder is linked", async () => {
    mockTauri();
    await expect(stemsCloudSavePath("Neon Nights")).rejects.toMatchObject({ kind: "not-found" });
  });

  it("estimates the size of the file with or without the original", async () => {
    const calls = mockTauri({ stems_estimate_bundle: () => ({ bytes: 123 }) });
    await expect(estimateStemBundle("abc", false)).resolves.toEqual({ bytes: 123 });
    expect(calls).toContainEqual({
      cmd: "stems_estimate_bundle",
      args: { id: "abc", includeOriginal: false },
    });
  });

  it("touches and pins a song", async () => {
    const calls = mockTauri();
    backend.stemSongs = [STEM_SONG];
    await touchStemSong(STEM_SONG.id);
    await pinStemSong(STEM_SONG.id, true);
    expect(calls).toContainEqual({ cmd: "stems_touch", args: { id: STEM_SONG.id } });
    expect(calls).toContainEqual({ cmd: "stems_pin", args: { id: STEM_SONG.id, pinned: true } });
    expect(backend.stemSongs[0]).toMatchObject({ pinned: true });
    expect(backend.stemSongs[0]!.lastOpened).toBeTypeOf("number");
  });

  it("tells the handler the path of a file the system opened, until it stops listening", async () => {
    mockTauri();
    const paths: string[] = [];
    const stop = await onStemBundleOpened((path) => paths.push(path));
    await emitStemBundleOpened("/Downloads/Neon.sbstems");
    stop();
    await emitStemBundleOpened("/Downloads/Other.sbstems");
    expect(paths).toEqual(["/Downloads/Neon.sbstems"]);
  });

  it("hands over a file that opened the app before it was listening, once", async () => {
    const calls = mockTauri();
    backend.pendingStemBundles = ["/Downloads/Launch.sbstems"];
    const paths: string[] = [];
    const stop = await onStemBundleOpened((path) => paths.push(path));
    expect(paths).toEqual(["/Downloads/Launch.sbstems"]);
    expect(calls.filter((call) => call.cmd === "take_pending_stem_bundles")).toHaveLength(1);
    const again = await onStemBundleOpened((path) => paths.push(path));
    expect(paths).toEqual(["/Downloads/Launch.sbstems"]);
    stop();
    again();
  });

  it("asks the native dialogs for .sbstems files named Smart Beat stems", async () => {
    const calls = mockTauri();
    backend.saveResult = "/Music/Neon Nights.sbstems";
    backend.dialogResult = "/Music/Neon Nights.sbstems";
    await expect(pickStemBundleDestination("Neon Nights")).resolves.toBe(
      "/Music/Neon Nights.sbstems",
    );
    await expect(pickStemBundle()).resolves.toBe("/Music/Neon Nights.sbstems");
    const filters = [{ name: "Smart Beat stems", extensions: ["sbstems"] }];
    expect(calls).toContainEqual({
      cmd: "plugin:dialog|save",
      args: {
        options: expect.objectContaining({ defaultPath: "Neon Nights.sbstems", filters }),
      },
    });
    expect(calls).toContainEqual({
      cmd: "plugin:dialog|open",
      args: { options: expect.objectContaining({ multiple: false, filters }) },
    });
  });

  it("reveals a file in the folder", async () => {
    const calls = mockTauri();
    await revealInFolder("/Music/Neon.sbstems");
    expect(calls).toContainEqual({
      cmd: "plugin:opener|reveal_item_in_dir",
      args: { paths: ["/Music/Neon.sbstems"] },
    });
  });
});

describe("saved stems in a connected account", () => {
  it("is not available outside the desktop app", async () => {
    await expect(listCloudStemFiles("drive")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(
      saveStemBundleToCloud({ id: "a", provider: "drive", includeOriginal: true }),
    ).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(openStemBundleFromCloud("drive:a")).rejects.toBeInstanceOf(NotInDesktopAppError);
  });

  it("lists the stems files of one account", async () => {
    const files = [{ id: "drive:a", name: "Neon.sbstems", revision: "r", size: 9, modified_ms: 1 }];
    const calls = mockTauri({ cloud_list_stems: () => files });
    await expect(listCloudStemFiles("drive")).resolves.toEqual(files);
    expect(calls).toContainEqual({ cmd: "cloud_list_stems", args: { provider: "drive" } });
  });

  it("saves with the request as given and reports writing, then uploading", async () => {
    const calls = mockTauri({
      stems_cloud_save: async () => {
        await emit("stems-bundle-progress", { stage: "writing", fraction: 1 });
        await emit("stems-bundle-progress", { stage: "uploading", fraction: 0.5 });
        return {
          item: "dropbox:/Neon.sbstems",
          name: "Neon.sbstems",
          provider: "dropbox",
          bytes: 9,
          originalIncluded: true,
        };
      },
    });
    const seen: BundleProgress[] = [];
    const request = { id: "abc", provider: "dropbox", includeOriginal: true } as const;
    await expect(
      saveStemBundleToCloud(request, (progress) => seen.push(progress)),
    ).resolves.toMatchObject({ item: "dropbox:/Neon.sbstems", name: "Neon.sbstems" });
    expect(calls).toContainEqual({ cmd: "stems_cloud_save", args: { request } });
    expect(seen).toEqual([
      { stage: "writing", fraction: 1 },
      { stage: "uploading", fraction: 0.5 },
    ]);
  });

  it("opens an item and returns its song, reporting the download", async () => {
    const calls = mockTauri({
      stems_cloud_open: async () => {
        await emit("stems-bundle-progress", { stage: "downloading", fraction: 0.2 });
        return { ...STEM_SONG, savedPath: "drive:abc" };
      },
    });
    const seen: BundleProgress[] = [];
    const opened = await openStemBundleFromCloud("drive:abc", (progress) => seen.push(progress));
    expect(opened).toMatchObject({ id: STEM_SONG.id, savedPath: "drive:abc" });
    expect(calls).toContainEqual({
      cmd: "stems_cloud_open",
      args: { request: { item: "drive:abc" } },
    });
    expect(seen).toEqual([{ stage: "downloading", fraction: 0.2 }]);
  });

  it("tells a stop from a failure", () => {
    expect(isStemFileStopped({ kind: "io", message: "Stem file stopped." })).toBe(true);
    expect(isStemFileStopped({ kind: "io", message: "Disk full." })).toBe(false);
    expect(isStemFileStopped(new Error("Stem file stopped."))).toBe(false);
  });
});
