import {
  engineInfo,
  engineLabel,
  ENGINES,
  fallbackEngine,
  NEURAL_ENGINES,
  neuralParts,
  offeredEngines,
} from "@/components/stems/stem-engines";
import { STEM_HINTS, STEM_LABELS, stemLimit, stemName } from "@/components/stems/stem-labels";
import { STEM_KINDS, STEM_MODELS, type StemEngine } from "@/lib/tauri";

describe("the engine list", () => {
  it("lists Fast first, then the recommended model, its 6-part variant, SCNet XL, SCNet Small and UMX-HQ", () => {
    expect(ENGINES.map((engine) => engine.id)).toEqual([
      "fast",
      "htdemucs",
      "htdemucs-6s",
      "scnet-xl",
      "scnet",
      "neural",
    ]);
    expect(NEURAL_ENGINES).toEqual(["htdemucs", "htdemucs-6s", "scnet-xl", "scnet", "neural"]);
  });

  it("recommends HTDemucs and nothing else", () => {
    expect(ENGINES.filter((engine) => engine.recommended).map((engine) => engine.id)).toEqual([
      "htdemucs",
    ]);
  });

  it("notes what each model is best at and what it costs", () => {
    for (const engine of ENGINES) {
      expect(engine.strength.length).toBeGreaterThan(10);
      expect(engine.speed.length).toBeGreaterThan(10);
    }
    expect(engineInfo("scnet-xl").strength).toContain("vocals");
    expect(engineInfo("htdemucs").strength).toContain("all-round");
  });

  it("names every engine, and reads an unknown one as Fast", () => {
    expect(ENGINES.map((engine) => engineLabel(engine.id))).toEqual([
      "Fast",
      "HTDemucs",
      "HTDemucs 6-part",
      "SCNet XL",
      "SCNet Small",
      "UMX-HQ",
    ]);
    expect(engineLabel("old-engine" as StemEngine)).toBe("Fast");
  });

  it("describes Other as the rest for every neural engine, not for Fast", () => {
    expect(stemLimit("other", "fast")).toBe("Everything that was not separated.");
    for (const id of NEURAL_ENGINES.filter((id) => id !== "htdemucs-6s")) {
      expect(stemLimit("other", id)).toBe("Everything that is not drums, bass or vocals.");
    }
    expect(stemLimit("other", "htdemucs-6s")).toBe(
      "Everything that is not drums, bass, vocals, guitar or piano.",
    );
  });

  it("is honest about the 6-part engine: guitar and piano are weaker, and it is not recommended", () => {
    const six = engineInfo("htdemucs-6s");
    expect(six.strength).toContain("guitar, piano");
    expect(six.strength).toContain("weaker");
    expect(six.recommended).toBeUndefined();
    expect(six.hiddenUntilAvailable).toBe(true);
    expect(six.partsNote).toContain("piano is the weakest");
    // No other engine is hidden, and none claims guitar or piano.
    expect(ENGINES.filter((engine) => engine.hiddenUntilAvailable)).toEqual([six]);
    for (const engine of ENGINES.filter((engine) => engine !== six)) {
      expect(engine.strength).not.toMatch(/guitar|piano/i);
    }
  });

  it("makes guitar and piano only with the 6-part engine", () => {
    expect(neuralParts("htdemucs-6s")).toEqual(["drums", "bass", "vocals", "guitar", "piano"]);
    for (const id of ["htdemucs", "scnet", "scnet-xl", "neural"] as const) {
      expect(neuralParts(id)).toEqual(["drums", "bass", "vocals"]);
    }
  });

  it("offers the 6-part engine only when its model is available", () => {
    const ids = (states: Parameters<typeof offeredEngines>[0]) =>
      offeredEngines(states).map((engine) => engine.id);
    expect(ids({})).toEqual(["fast", "htdemucs", "scnet-xl", "scnet", "neural"]);
    expect(ids({ "htdemucs-6s": { available: false } })).not.toContain("htdemucs-6s");
    expect(ids({ "htdemucs-6s": { available: true } })).toContain("htdemucs-6s");
  });

  it("knows every model the app can download", () => {
    for (const model of STEM_MODELS) expect(NEURAL_ENGINES).toContain(model);
  });
});

describe("the parts", () => {
  it("labels, describes and limits every part, with guitar and piano after the vocals", () => {
    expect(STEM_KINDS).toEqual(["drums", "bass", "vocals", "guitar", "piano", "panned", "other"]);
    for (const kind of STEM_KINDS) {
      expect(STEM_LABELS[kind].length).toBeGreaterThan(2);
      expect(STEM_HINTS[kind].length).toBeGreaterThan(10);
      expect(stemLimit(kind, "htdemucs-6s").length).toBeGreaterThan(10);
    }
    expect(STEM_LABELS.guitar).toBe("Guitar");
    expect(STEM_LABELS.piano).toBe("Piano");
    expect(stemName("guitar", "htdemucs-6s")).toBe("Guitar");
    expect(stemName("piano", "htdemucs-6s")).toBe("Piano");
  });

  it("states the limits of guitar and piano plainly", () => {
    expect(stemLimit("guitar", "htdemucs-6s")).toMatch(
      /weaker.*distorted guitar can leak into Other/,
    );
    expect(stemLimit("piano", "htdemucs-6s")).toMatch(/weakest.*thin or incomplete/);
  });
});

describe("the engine after a delete", () => {
  it("is the next model on the list that is ready, going round, or Fast", () => {
    const ready =
      (...ids: StemEngine[]) =>
      (engine: StemEngine) =>
        ids.includes(engine);
    expect(fallbackEngine("htdemucs", ready("htdemucs", "scnet"))).toBe("scnet");
    expect(fallbackEngine("scnet", ready("htdemucs", "scnet"))).toBe("htdemucs");
    expect(fallbackEngine("htdemucs", ready("htdemucs", "htdemucs-6s", "neural"))).toBe(
      "htdemucs-6s",
    );
    expect(fallbackEngine("htdemucs", ready("htdemucs"))).toBe("fast");
    expect(fallbackEngine("neural", ready())).toBe("fast");
  });
});
