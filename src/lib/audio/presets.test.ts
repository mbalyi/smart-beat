import {
  EFFECT_LABELS,
  MAX_MASTER_EFFECTS,
  MAX_TRACK_EFFECTS,
  PARAMS,
  type EffectSlot,
} from "@/lib/audio/effects";
import {
  BUILTIN_PRESETS,
  chainOf,
  deleteUserPreset,
  GENRES,
  presetsFor,
  presetTargetOf,
  readUserPresets,
  saveUserPreset,
} from "@/lib/audio/presets";

const BUILTIN_CABS = ["4x12-modern", "4x12-vintage", "2x12-open", "8x10-bass"];

function checkSlot(slot: EffectSlot, where: string) {
  expect(EFFECT_LABELS[slot.type], where).toBeDefined();
  expect(typeof slot.enabled, where).toBe("boolean");
  for (const spec of PARAMS[slot.type] ?? []) {
    const value = (slot as unknown as Record<string, number>)[spec.key];
    expect(value, `${where}: ${spec.key}`).toBeGreaterThanOrEqual(spec.min);
    expect(value, `${where}: ${spec.key}`).toBeLessThanOrEqual(spec.max);
  }
  if (slot.type === "cab") expect(BUILTIN_CABS.map((c) => `builtin:${c}`)).toContain(slot.ir);
  if (slot.type === "eq") {
    for (const band of slot.bands) {
      expect(band.freq).toBeGreaterThan(10);
      expect(Math.abs(band.gainDb)).toBeLessThanOrEqual(24);
    }
  }
}

describe("bundled presets", () => {
  it("cover every genre and target, with unique ids", () => {
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
    for (const genre of GENRES) {
      expect(BUILTIN_PRESETS.some((p) => p.target === "guitar" && p.genres.includes(genre))).toBe(
        true,
      );
    }
    for (const target of ["guitar", "bass", "drums", "master"] as const) {
      expect(presetsFor(target).length).toBeGreaterThan(0);
    }
  });

  it.each(BUILTIN_PRESETS.map((p) => [p.id, p] as const))("%s is a valid chain", (id, preset) => {
    const limit = preset.target === "master" ? MAX_MASTER_EFFECTS : MAX_TRACK_EFFECTS;
    expect(preset.chain.length).toBeGreaterThan(0);
    expect(preset.chain.length).toBeLessThanOrEqual(limit);
    preset.chain.forEach((slot, i) => checkSlot(slot, `${id}[${i}]`));
    // Amp captures are the user's own: bundled presets never need one.
    expect(preset.chain.some((s) => s.type === "amp")).toBe(false);
  });

  it("are copied, so editing a track's chain never changes the preset", () => {
    const preset = BUILTIN_PRESETS[0]!;
    const chain = chainOf(preset);
    chain[0]!.enabled = false;
    expect(preset.chain[0]!.enabled).toBe(true);
  });
});

describe("presetsFor", () => {
  it("filters by target and genre", () => {
    expect(presetsFor("guitar", "djent").map((p) => p.id)).toEqual([
      "djent-8-string",
      "ambient-clean-layer",
      "lead-delay",
    ]);
    expect(presetsFor("bass", "nu-metal").map((p) => p.id)).toEqual(["nu-metal-clanky-bass"]);
  });
});

describe("user presets", () => {
  beforeEach(() => localStorage.clear());

  it("saves, replaces by name, lists and deletes", () => {
    const chain = chainOf(BUILTIN_PRESETS[0]!);
    saveUserPreset(" My tone ", "guitar", chain);
    saveUserPreset("My tone", "guitar", chain.slice(0, 1));
    const saved = readUserPresets();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "My tone", user: true });
    expect(saved[0]!.chain).toHaveLength(1);
    expect(presetsFor("guitar", "djent").some((p) => p.id === saved[0]!.id)).toBe(true);
    deleteUserPreset(saved[0]!.id);
    expect(readUserPresets()).toEqual([]);
  });

  it("cuts master presets to three effects and survives bad storage", () => {
    const chain = chainOf(BUILTIN_PRESETS[0]!);
    expect(saveUserPreset("Big", "master", chain).chain).toHaveLength(MAX_MASTER_EFFECTS);
    localStorage.setItem("smart-beat:effect-presets", "{not json");
    expect(readUserPresets()).toEqual([]);
  });
});

describe("presetTargetOf", () => {
  it("knows drums and basses (GM programs 33–40)", () => {
    expect(presetTargetOf({ kind: "drums", program: 0 })).toBe("drums");
    expect(presetTargetOf({ kind: "stringed", program: 33 })).toBe("bass");
    expect(presetTargetOf({ kind: "stringed", program: 30 })).toBe("guitar");
  });
});
