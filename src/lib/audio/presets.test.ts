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
  drumsOf,
  filterPresets,
  GENRES,
  presetsFor,
  presetTargetOf,
  readUserPresets,
  saveUserPreset,
} from "@/lib/audio/presets";
import { DRUM_ELEMENTS } from "@/lib/audio/drum-elements";

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

describe("heavy-genre presets (#42)", () => {
  const heavy = [
    "nu-metal-crunch",
    "metalcore-tight",
    "hardcore-crunch",
    "deathcore-chug",
    "djent-8-string",
  ];

  it("builds the guitar chains as gate › compressor › boost › amp › cab › EQ", () => {
    for (const id of heavy) {
      const preset = BUILTIN_PRESETS.find((p) => p.id === id)!;
      expect(
        preset.chain.map((s) => s.type),
        id,
      ).toEqual(["gate", "compressor", "drive", "ampSim", "cab", "eq"]);
      expect(preset.chain[2]).toMatchObject({ mode: "overdrive" }); // the boost
    }
    expect(BUILTIN_PRESETS.find((p) => p.id === "ambient-clean-layer")).toBeDefined();
  });

  it("has bass, drum mix and mastering presets for every genre", () => {
    for (const genre of GENRES) {
      for (const [target, kind] of [
        ["bass", "chain"],
        ["drums", "drumMix"],
        ["master", "chain"],
      ] as const) {
        expect(
          filterPresets(BUILTIN_PRESETS, { genre, target, kind }).length,
          `${genre} ${target} ${kind}`,
        ).toBeGreaterThan(0);
      }
    }
    // Every mastering preset of a genre ends in the limiter.
    for (const genre of GENRES) {
      const masters = filterPresets(BUILTIN_PRESETS, { genre, target: "master" });
      expect(
        masters.some((p) => p.chain.at(-1)?.type === "limiter"),
        genre,
      ).toBe(true);
    }
  });

  it("gives drum mixes a level and pan for every kit piece, plus a bus chain", () => {
    const ids = DRUM_ELEMENTS.map((e) => e.id).sort();
    const mixes = BUILTIN_PRESETS.filter((p) => p.kind === "drumMix");
    expect(mixes.map((p) => p.id)).toContain("drummix-double-kick");
    for (const preset of mixes) {
      expect(preset.target).toBe("drums");
      expect(preset.drums!.elements.map((e) => e.id).sort(), preset.id).toEqual(ids);
      for (const element of preset.drums!.elements) {
        expect(element.volume).toBeGreaterThan(0);
        expect(element.volume).toBeLessThanOrEqual(1);
        expect(Math.abs(element.pan)).toBeLessThanOrEqual(1);
      }
      expect(
        preset.chain.some((s) => s.type === "compressor"),
        preset.id,
      ).toBe(true);
    }
    // The double-kick default keeps the kick the loudest piece.
    const kick = BUILTIN_PRESETS.find((p) => p.id === "drummix-double-kick")!.drums!;
    const level = (id: string) => kick.elements.find((e) => e.id === id)!.volume;
    expect(level("kick")).toBe(Math.max(...kick.elements.map((e) => e.volume)));
    expect(drumsOf(BUILTIN_PRESETS.find((p) => p.id === "drummix-double-kick")!)).not.toBe(kick);
  });

  it("filters by genre, target, kind and text", () => {
    expect(filterPresets(BUILTIN_PRESETS, { query: "sub-kick" }).map((p) => p.id)).toEqual([
      "drummix-djent-sub",
    ]);
    expect(
      filterPresets(BUILTIN_PRESETS, { kind: "drumMix" }).every((p) => p.kind === "drumMix"),
    ).toBe(true);
    expect(presetsFor("drums").every((p) => p.kind === "chain")).toBe(true);
  });

  it("reads presets the user saved before drum mixes existed as chains", () => {
    localStorage.setItem(
      "smart-beat:effect-presets",
      JSON.stringify([
        {
          id: "user:guitar:old",
          name: "Old",
          target: "guitar",
          genres: [],
          description: "",
          chain: [],
        },
      ]),
    );
    expect(readUserPresets()[0]).toMatchObject({ kind: "chain", user: true });
    localStorage.removeItem("smart-beat:effect-presets");
  });
});
