import {
  copyToClipboard,
  createShareLink,
  stemShareTarget,
  tabShareTarget,
  targetProvider,
  uploadForShare,
} from "@/lib/cloud-share";
import { mockTauri } from "@/test/tauri";

describe("share targets", () => {
  it("shares a tab that is in a drive as it is, and uploads one on this computer", () => {
    expect(tabShareTarget("drive:f1", "riff.gp")).toEqual({
      kind: "cloud",
      item: "drive:f1",
      name: "riff.gp",
    });
    expect(tabShareTarget("/songs/riff.gp5")).toEqual({
      kind: "tab",
      path: "/songs/riff.gp5",
      name: "riff.gp5",
    });
    // A Windows path is not a drive item.
    expect(tabShareTarget("C:\\songs\\riff.gp5").kind).toBe("tab");
  });

  it("shares separated songs that are saved in a drive as that file", () => {
    const song = { id: "a".repeat(16), name: "Neon Nights" };
    expect(stemShareTarget({ ...song, savedPath: "dropbox:/Neon Nights.sbstems" })).toEqual({
      kind: "cloud",
      item: "dropbox:/Neon Nights.sbstems",
      name: "Neon Nights.sbstems",
    });
    expect(stemShareTarget({ ...song, savedPath: "/Users/me/Neon.sbstems" }).kind).toBe("stems");
    expect(stemShareTarget({ ...song, savedPath: null })).toEqual({
      kind: "stems",
      songId: song.id,
      name: "Neon Nights",
    });
  });

  it("knows the drive a target is in already", () => {
    expect(targetProvider({ kind: "cloud", item: "onedrive:9", name: "a.gp" })).toBe("onedrive");
    expect(targetProvider({ kind: "tab", path: "/a.gp", name: "a.gp" })).toBeNull();
  });
});

describe("share calls", () => {
  it("asks the core for a link of the chosen level", async () => {
    const calls = mockTauri();
    await expect(createShareLink("drive:f1", "edit")).resolves.toBe(
      "https://share.example.com/drive%3Af1?as=edit",
    );
    expect(calls.find((c) => c.cmd === "cloud_share")?.args).toEqual({
      item: "drive:f1",
      level: "edit",
    });
  });

  it("copies a local tab as the file it is, under its own name", async () => {
    const calls = mockTauri({
      read_score_file: () => new Uint8Array([7, 8]).buffer,
      cloud_create: () => "dropbox:/riff.gp5",
    });
    const item = await uploadForShare(
      { kind: "tab", path: "/songs/riff.gp5", name: "riff.gp5" },
      "dropbox",
    );
    expect(item).toBe("dropbox:/riff.gp5");
    const create = calls.find((c) => c.cmd === "cloud_create");
    expect(create?.headers).toEqual({ provider: "dropbox", name: "riff.gp5" });
    expect(Array.from(new Uint8Array(create?.args as ArrayBuffer))).toEqual([7, 8]);
  });

  it("saves stems without the original song", async () => {
    const calls = mockTauri();
    const item = await uploadForShare(
      { kind: "stems", songId: "a".repeat(16), name: "Neon Nights" },
      "onedrive",
    );
    expect(item).toBe("onedrive:1");
    expect(calls.find((c) => c.cmd === "stems_cloud_save")?.args).toEqual({
      request: { id: "a".repeat(16), provider: "onedrive", includeOriginal: false },
    });
  });

  it("reports whether the clipboard took the text", async () => {
    const write = vi.fn().mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    await expect(copyToClipboard("https://x")).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith("https://x");
    write.mockRejectedValueOnce(new Error("denied"));
    await expect(copyToClipboard("https://x")).resolves.toBe(false);
  });
});
