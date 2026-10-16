import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { resetSoundFontLibrary, useSoundFonts } from "@/hooks/use-soundfonts";
import {
  downloadCatalogueSoundFont,
  importStoredSoundFont,
  listStoredSoundFonts,
  removeStoredSoundFont,
  soundFontCatalogue,
  type SoundFontCatalogueItem,
  type StoredSoundFont,
} from "@/lib/tauri";
import { track } from "@/lib/telemetry";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  listStoredSoundFonts: vi.fn(),
  soundFontCatalogue: vi.fn(),
  importStoredSoundFont: vi.fn(),
  removeStoredSoundFont: vi.fn(),
  downloadCatalogueSoundFont: vi.fn(),
  cancelSoundFontDownload: vi.fn(),
  pickSoundFontFile: vi.fn(),
  SOUNDFONT_DOWNLOAD_CANCELLED: "cancelled",
}));

const bank = (id: string, catalogue: string | null = null): StoredSoundFont => ({
  id,
  name: id,
  file: `${id}.sf2`,
  bytes: 5_000_000,
  catalogue,
});

/** What the app has on disk; the mocked commands read and change it like the Rust side does. */
let disk: StoredSoundFont[] = [];
const item = (id: string): SoundFontCatalogueItem => ({
  id,
  name: id,
  description: "",
  licence: "MIT",
  personalUseOnly: false,
  page: "https://example.com/",
  downloadBytes: 1,
  bytes: 1,
  installed: disk.some((font) => font.catalogue === id),
});

beforeEach(() => {
  resetSoundFontLibrary();
  disk = [];
  vi.mocked(listStoredSoundFonts).mockImplementation(async () => [...disk]);
  vi.mocked(soundFontCatalogue).mockImplementation(async () => [item("arachno")]);
  vi.mocked(importStoredSoundFont).mockImplementation(async () => {
    const font = bank("my-bank");
    disk = [...disk, font];
    return font;
  });
  vi.mocked(removeStoredSoundFont).mockImplementation(async (id) => {
    disk = disk.filter((font) => font.id !== id);
    return undefined as never;
  });
  vi.mocked(downloadCatalogueSoundFont).mockImplementation(async () => {
    const font = bank("arachno", "arachno");
    disk = [...disk, font];
    return font;
  });
});
afterEach(() => vi.clearAllMocks());

describe("useSoundFonts (#81)", () => {
  it("lists what is installed and the recommended banks once, however many songs are open", async () => {
    disk = [bank("existing")];
    const first = renderHook(() => useSoundFonts());
    const second = renderHook(() => useSoundFonts());

    await waitFor(() =>
      expect(first.result.current.fonts.map((f) => f.id)).toEqual(["stored:existing"]),
    );
    expect(second.result.current.fonts.map((f) => f.id)).toEqual(["stored:existing"]);
    expect(first.result.current.catalogue.map((c) => c.id)).toEqual(["arachno"]);
    expect(listStoredSoundFonts).toHaveBeenCalledTimes(1);
  });

  it("shows a SoundFont imported in one open song in the other open song", async () => {
    const one = renderHook(() => useSoundFonts());
    const two = renderHook(() => useSoundFonts());
    await waitFor(() => expect(soundFontCatalogue).toHaveBeenCalled());

    await act(async () => {
      await one.result.current.importFrom("/music/My Bank.sf2");
    });

    expect(one.result.current.stored.map((f) => f.id)).toEqual(["my-bank"]);
    expect(two.result.current.stored.map((f) => f.id)).toEqual(["my-bank"]);
    expect(two.result.current.fonts.map((f) => f.label)).toEqual(["my-bank"]);
    expect(track).toHaveBeenCalledWith("soundfont_import");
  });

  it("shows a downloaded bank as installed in the other open song's dialog", async () => {
    const one = renderHook(() => useSoundFonts());
    const two = renderHook(() => useSoundFonts());
    await waitFor(() => expect(soundFontCatalogue).toHaveBeenCalled());

    await act(async () => {
      await one.result.current.download("arachno", () => {});
    });

    expect(two.result.current.catalogue.find((c) => c.id === "arachno")?.installed).toBe(true);
    expect(two.result.current.fonts.map((f) => f.id)).toEqual(["stored:arachno"]);
    expect(track).toHaveBeenCalledWith("soundfont_download", "arachno");
  });

  it("takes a removed SoundFont out of every open song's list, so it cannot be picked", async () => {
    disk = [bank("my-bank")];
    const one = renderHook(() => useSoundFonts());
    const two = renderHook(() => useSoundFonts());
    await waitFor(() => expect(two.result.current.fonts).toHaveLength(1));

    await act(async () => {
      await two.result.current.remove("my-bank");
    });

    expect(one.result.current.fonts).toEqual([]);
    expect(two.result.current.fonts).toEqual([]);
  });

  it("gives a song opened later the current list at once, and refreshes it on request", async () => {
    const one = renderHook(() => useSoundFonts());
    await waitFor(() => expect(soundFontCatalogue).toHaveBeenCalled());
    await act(async () => {
      await one.result.current.importFrom("/music/My Bank.sf2");
    });

    const later = renderHook(() => useSoundFonts());
    expect(later.result.current.fonts.map((f) => f.id)).toEqual(["stored:my-bank"]);
    expect(listStoredSoundFonts).toHaveBeenCalledTimes(2); // not read again for the new song

    disk = []; // changed behind the app's back, for example by hand
    await act(async () => {
      await later.result.current.refresh();
    });
    expect(one.result.current.fonts).toEqual([]);
    expect(later.result.current.fonts).toEqual([]);
  });

  it("says so when the library cannot be read, and when a SoundFont cannot be removed", async () => {
    vi.mocked(listStoredSoundFonts).mockRejectedValueOnce(new Error("disk"));
    const { result } = renderHook(() => useSoundFonts());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The SoundFonts could not be read", {
        description: "disk",
      }),
    );

    vi.mocked(removeStoredSoundFont).mockRejectedValueOnce(new Error("in use"));
    let removed = true;
    await act(async () => {
      removed = await result.current.remove("my-bank");
    });
    expect(removed).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("The SoundFont could not be removed", {
      description: "in use",
    });
  });

  it("returns nothing for a download the user cancelled and throws any other failure", async () => {
    const { result } = renderHook(() => useSoundFonts());
    vi.mocked(downloadCatalogueSoundFont).mockRejectedValueOnce(new Error("cancelled"));
    await expect(result.current.download("arachno", () => {})).resolves.toBeNull();

    vi.mocked(downloadCatalogueSoundFont).mockRejectedValueOnce(new Error("offline"));
    await expect(result.current.download("arachno", () => {})).rejects.toThrow("offline");
    expect(track).not.toHaveBeenCalledWith("soundfont_download", expect.anything());
  });
});
