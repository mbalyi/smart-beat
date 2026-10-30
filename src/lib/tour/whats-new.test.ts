import { FEATURE_REGISTRY, type FeatureEntry } from "@/lib/tour/feature-registry";
import { compareVersions, latestFeatures, pendingFeatures } from "@/lib/tour/whats-new";

const f = (id: string, since: string): FeatureEntry => ({ id, title: id, summary: id, since });
const registry = [
  f("a", "1.0.0"),
  f("b", "1.1.0"),
  f("c", "1.1.0"),
  f("d", "1.2.0"),
  f("e", "2.0.0"),
];
const ids = (list: FeatureEntry[]) => list.map((x) => x.id);

describe("compareVersions", () => {
  it("compares numerically per part", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });
  it("treats missing or malformed parts as 0", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.x.2", "1.0.2")).toBe(0);
    expect(compareVersions("", "0.0.1")).toBe(-1);
  });
  it("ignores a pre-release suffix beyond three parts", () => {
    expect(compareVersions("1.1.0-beta", "1.1.0")).toBe(0);
  });
});

describe("pendingFeatures", () => {
  it("is empty without a last seen version", () => {
    expect(pendingFeatures(null, "2.0.0", registry)).toEqual([]);
  });
  it("excludes the last seen version and includes the current one", () => {
    expect(ids(pendingFeatures("1.0.0", "1.1.0", registry))).toEqual(["b", "c"]);
    expect(ids(pendingFeatures("1.0.0", "1.2.0", registry))).toEqual(["b", "c", "d"]);
  });
  it("excludes versions newer than the running one", () => {
    expect(ids(pendingFeatures("1.0.0", "1.1.5", registry))).toEqual(["b", "c"]);
  });
  it("is empty when up to date", () => {
    expect(pendingFeatures("2.0.0", "2.0.0", registry)).toEqual([]);
    expect(pendingFeatures("1.1.0", "1.1.0", registry)).toEqual([]);
  });
  it("shows the cloud folder to users coming from 1.1.0 once 1.2.0 runs", () => {
    const shown = pendingFeatures("1.1.0", "1.2.0", FEATURE_REGISTRY);
    expect(shown.map((x) => x.id)).toContain("cloud-folder");
    expect(pendingFeatures("1.1.0", "1.1.0", FEATURE_REGISTRY)).toEqual([]);
  });
  it("uses the real registry by default", () => {
    expect(Array.isArray(pendingFeatures("0.0.1", "99.0.0"))).toBe(true);
    expect(pendingFeatures("0.0.1", "99.0.0").length).toBeGreaterThan(0);
  });
});

describe("latestFeatures", () => {
  it("returns the newest version with its features", () => {
    expect(latestFeatures(registry)).toEqual({ version: "2.0.0", features: [registry[4]] });
    expect(ids(latestFeatures(registry.slice(0, 3)).features)).toEqual(["b", "c"]);
  });
  it("handles an empty registry", () => {
    expect(latestFeatures([])).toEqual({ version: "0.0.0", features: [] });
  });
  it("is order independent", () => {
    expect(latestFeatures([...registry].reverse()).version).toBe("2.0.0");
  });
});

describe("stem separation in the registry (#186)", () => {
  it("is announced in 1.2.0", () => {
    const entry = FEATURE_REGISTRY.find((x) => x.id === "stem-separation");
    expect(entry).toMatchObject({ title: "Stem separation", since: "1.2.0" });
    expect(pendingFeatures("1.1.0", "1.2.0", FEATURE_REGISTRY).map((x) => x.id)).toContain(
      "stem-separation",
    );
    expect(pendingFeatures("1.2.0", "1.2.0", FEATURE_REGISTRY)).toEqual([]);
  });
});
