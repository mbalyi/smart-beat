import { overallProgress } from "@/lib/stems/progress";

describe("overallProgress", () => {
  it("is 0 before anything is reported and 1 when done", () => {
    expect(overallProgress(null)).toBe(0);
    expect(overallProgress({ stage: "done", fraction: 0 })).toBe(1);
  });

  it("fills the bar stage by stage", () => {
    expect(overallProgress({ stage: "reading", fraction: 0.5 })).toBeCloseTo(0.05);
    expect(overallProgress({ stage: "separating", fraction: 0 })).toBeCloseTo(0.1);
    expect(overallProgress({ stage: "separating", fraction: 0.5 })).toBeCloseTo(0.5);
    expect(overallProgress({ stage: "saving", fraction: 0 })).toBeCloseTo(0.9);
    expect(overallProgress({ stage: "saving", fraction: 1 })).toBeCloseTo(1);
  });

  it("never goes backwards across stages, and keeps odd values inside the bar", () => {
    const at = (stage: "reading" | "separating" | "saving", fraction: number) =>
      overallProgress({ stage, fraction });
    expect(at("reading", 1)).toBeLessThanOrEqual(at("separating", 0));
    expect(at("separating", 1)).toBeLessThanOrEqual(at("saving", 0) + 1e-9);
    expect(at("separating", 7)).toBeCloseTo(0.9);
    expect(at("separating", -1)).toBeCloseTo(0.1);
    expect(at("separating", NaN)).toBeCloseTo(0.1);
  });
});
