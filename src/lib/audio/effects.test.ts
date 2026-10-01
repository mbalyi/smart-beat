import {
  addEffect,
  defaultEffect,
  describeChain,
  EFFECT_LABELS,
  formatParam,
  graphicBands,
  MAX_TRACK_EFFECTS,
  moveEffect,
  PARAMS,
  removeEffect,
  replaceEffect,
  withBandGain,
  withParam,
  withFocusBlock,
  type EffectType,
} from "@/lib/audio/effects";

const TYPES = Object.keys(EFFECT_LABELS) as EffectType[];

describe("defaultEffect", () => {
  it.each(TYPES)("makes an enabled %s whose values are inside the knob ranges", (type) => {
    const slot = defaultEffect(type);
    expect(slot).toMatchObject({ type, enabled: true });
    for (const spec of PARAMS[type] ?? []) {
      const value = (slot as unknown as Record<string, number>)[spec.key]!;
      expect(value).toBeGreaterThanOrEqual(spec.min);
      expect(value).toBeLessThanOrEqual(spec.max);
    }
  });

  it("starts the EQ as a flat ten-band graphic EQ and the cabinet on a built-in one", () => {
    const eq = defaultEffect("eq");
    expect(eq.type === "eq" && eq.bands.map((b) => b.freq)).toEqual([
      31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
    ]);
    expect(defaultEffect("cab")).toMatchObject({ ir: "builtin:4x12-modern" });
  });
});

describe("editing a block", () => {
  it("clamps parameters and ignores unknown or invalid ones", () => {
    const comp = defaultEffect("compressor");
    expect(withParam(comp, "ratio", 50)).toMatchObject({ ratio: 20 });
    expect(withParam(comp, "thresholdDb", -100)).toMatchObject({ thresholdDb: -60 });
    expect(withParam(comp, "nope", 3)).toBe(comp);
    expect(withParam(comp, "ratio", Number.NaN)).toBe(comp);
  });

  it("sets an EQ band's gain within ±24 dB", () => {
    const eq = defaultEffect("eq");
    const louder = withBandGain(eq, 3, 40);
    expect(louder.type === "eq" && louder.bands[3]!.gainDb).toBe(24);
    expect(louder.type === "eq" && louder.bands[2]!.gainDb).toBe(0);
    expect(withBandGain(defaultEffect("gate"), 0, 3)).toMatchObject({ type: "gate" });
    expect(graphicBands([3, -2])[1]!.gainDb).toBe(-2);
  });

  it("formats values with their units", () => {
    const [threshold, ratio, , , , , mix] = PARAMS.compressor!;
    expect(formatParam(threshold!, -18)).toBe("-18.0 dB");
    expect(formatParam(ratio!, 4)).toBe("4.0:1");
    expect(formatParam(mix!, 0.4)).toBe("40%");
  });
});

describe("editing a chain", () => {
  it("adds up to the limit, removes, moves and replaces blocks", () => {
    let chain = addEffect([], "gate", MAX_TRACK_EFFECTS);
    chain = addEffect(chain, "drive", MAX_TRACK_EFFECTS);
    chain = addEffect(chain, "cab", MAX_TRACK_EFFECTS);
    expect(chain.map((s) => s.type)).toEqual(["gate", "drive", "cab"]);
    expect(moveEffect(chain, 0, 2).map((s) => s.type)).toEqual(["drive", "cab", "gate"]);
    expect(moveEffect(chain, 0, 9)).toEqual(chain);
    expect(removeEffect(chain, 1).map((s) => s.type)).toEqual(["gate", "cab"]);
    const off = replaceEffect(chain, 0, { ...chain[0]!, enabled: false });
    expect(describeChain(off)).toBe("Drive → Cabinet");
    expect(describeChain([])).toBe("No effects");
    const full = Array.from({ length: 6 }, () => defaultEffect("eq"));
    expect(addEffect(full, "gate", MAX_TRACK_EFFECTS)).toHaveLength(6);
  });
});

describe("withFocusBlock", () => {
  it("finds the block, adds one at the end, or reports a full chain", () => {
    const gate = defaultEffect("gate");
    expect(withFocusBlock([gate, defaultEffect("eq")], "eq", 6).index).toBe(1);
    const added = withFocusBlock([gate], "eq", 6);
    expect(added.index).toBe(1);
    expect(added.chain.map((s) => s.type)).toEqual(["gate", "eq"]);
    expect(withFocusBlock([gate, gate, gate], "eq", 3)).toEqual({
      chain: [gate, gate, gate],
      index: -1,
    });
  });
});
