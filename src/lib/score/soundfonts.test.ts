import {
  DEFAULT_SOUNDFONT,
  getSoundFont,
  isSoundFontId,
  readSoundFontPreference,
  SOUNDFONT_STORAGE_KEY,
  SOUNDFONTS,
  storeSoundFontPreference,
} from "@/lib/score/soundfonts";

describe("soundfonts", () => {
  it("offers Sonivox by default and FluidR3 as an option", () => {
    expect(DEFAULT_SOUNDFONT).toBe("sonivox");
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
    expect(readSoundFontPreference()).toBe("sonivox");

    storeSoundFontPreference("fluidr3");

    expect(localStorage.getItem(SOUNDFONT_STORAGE_KEY)).toBe("fluidr3");
    expect(readSoundFontPreference()).toBe("fluidr3");
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem(SOUNDFONT_STORAGE_KEY, "casio");
    expect(readSoundFontPreference()).toBe("sonivox");
  });

  it("copes with unavailable storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(readSoundFontPreference()).toBe("sonivox");
    expect(() => storeSoundFontPreference("fluidr3")).not.toThrow();
  });
});
