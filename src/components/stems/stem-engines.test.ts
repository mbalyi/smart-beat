import { engineInfo, engineLabel, ENGINES, NEURAL_ENGINES } from "@/components/stems/stem-engines";
import { stemLimit } from "@/components/stems/stem-labels";
import type { StemEngine } from "@/lib/tauri";

describe("the engine list", () => {
  it("lists Fast first, then the recommended model, SCNet XL, SCNet Small and UMX-HQ", () => {
    expect(ENGINES.map((engine) => engine.id)).toEqual([
      "fast",
      "htdemucs",
      "scnet-xl",
      "scnet",
      "neural",
    ]);
    expect(NEURAL_ENGINES).toEqual(["htdemucs", "scnet-xl", "scnet", "neural"]);
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
      "SCNet XL",
      "SCNet Small",
      "UMX-HQ",
    ]);
    expect(engineLabel("old-engine" as StemEngine)).toBe("Fast");
  });

  it("describes Other as the rest for every neural engine, not for Fast", () => {
    expect(stemLimit("other", "fast")).toBe("Everything that was not separated.");
    for (const id of NEURAL_ENGINES) {
      expect(stemLimit("other", id)).toBe("Everything that is not drums, bass or vocals.");
    }
  });
});
