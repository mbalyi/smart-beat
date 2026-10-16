import {
  allSoundFonts,
  DEFAULT_SOUNDFONT,
  FALLBACK_SOUNDFONT,
  getSoundFont,
  isSoundFontId,
  isStoredSoundFontId,
  readSoundFontPreference,
  SOUNDFONT_STORAGE_KEY,
  SOUNDFONTS,
  soundFontFromStored,
  soundFontUrl,
  storedKey,
  storedSoundFontId,
  storeSoundFontPreference,
} from "@/lib/score/soundfonts";

describe("soundfonts", () => {
  it("offers Sonivox by default and FluidR3 as an option", () => {
    expect(DEFAULT_SOUNDFONT).toBe("fluidr3");
    expect(FALLBACK_SOUNDFONT).toBe("sonivox");
    expect(SOUNDFONTS.map((f) => f.url)).toEqual([
      "/soundfont/sonivox.sf3",
      "/soundfont/FluidR3Mono_GM.sf3",
    ]);
  });

  it("looks sound fonts up by id", () => {
    expect(getSoundFont("fluidr3").label).toBe("High quality");
    expect(isSoundFontId("fluidr3")).toBe(true);
    expect(isSoundFontId("nope")).toBe(false);
  });

  it("remembers the choice", () => {
    expect(readSoundFontPreference()).toBe(DEFAULT_SOUNDFONT);

    storeSoundFontPreference("sonivox");

    expect(localStorage.getItem(SOUNDFONT_STORAGE_KEY)).toBe("sonivox");
    expect(readSoundFontPreference()).toBe("sonivox");
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem(SOUNDFONT_STORAGE_KEY, "casio");
    expect(readSoundFontPreference()).toBe(DEFAULT_SOUNDFONT);
  });

  it("copes with unavailable storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(readSoundFontPreference()).toBe(DEFAULT_SOUNDFONT);
    expect(() => storeSoundFontPreference("fluidr3")).not.toThrow();
  });

  describe("SoundFonts the user added (#81)", () => {
    const imported = {
      id: "my-bank",
      name: "My Bank",
      file: "my-bank.sf2",
      bytes: 32_319_396,
      catalogue: null,
    };
    const downloaded = { ...imported, id: "arachno", name: "Arachno", catalogue: "arachno" };

    it("names them stored:<id> and converts back", () => {
      expect(storedSoundFontId("my-bank")).toBe("stored:my-bank");
      expect(isStoredSoundFontId("stored:my-bank")).toBe(true);
      expect(isStoredSoundFontId("sonivox")).toBe(false);
      expect(storedKey("stored:my-bank")).toBe("my-bank");
    });

    it("accepts a stored id as a sound set, but not an empty one", () => {
      expect(isSoundFontId("stored:my-bank")).toBe(true);
      expect(isSoundFontId("stored:")).toBe(false);
      expect(isSoundFontId(42)).toBe(false);
    });

    it("describes an imported and a downloaded bank for the picker", () => {
      expect(soundFontFromStored(imported)).toEqual({
        id: "stored:my-bank",
        label: "My Bank",
        description: "Imported, 32 MB",
        url: "stored:my-bank",
        stored: true,
        catalogue: null,
      });
      expect(soundFontFromStored(downloaded).description).toBe("Downloaded, 32 MB");
      expect(soundFontFromStored(downloaded).catalogue).toBe("arachno");
    });

    it("lists the bundled sets first, then the added ones", () => {
      const added = [soundFontFromStored(imported)];
      expect(allSoundFonts(added).map((f) => f.id)).toEqual([
        "sonivox",
        "fluidr3",
        "stored:my-bank",
      ]);
      expect(getSoundFont("stored:my-bank", added).label).toBe("My Bank");
      // A removed bank falls back to the first bundled set.
      expect(getSoundFont("stored:gone", added).id).toBe("sonivox");
    });

    it("loads a stored bank by its id and a bundled one by its file", () => {
      expect(soundFontUrl("stored:my-bank")).toBe("stored:my-bank");
      expect(soundFontUrl("fluidr3")).toBe("/soundfont/FluidR3Mono_GM.sf3");
    });

    it("remembers a stored choice", () => {
      storeSoundFontPreference("stored:my-bank");
      expect(readSoundFontPreference()).toBe("stored:my-bank");
    });
  });
});
