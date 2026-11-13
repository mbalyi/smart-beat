import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { FEATURE_REGISTRY } from "@/lib/tour/feature-registry";
import { TOUR_LIST, TOURS } from "@/lib/tour/tours";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith(".tsx") && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

const source = tsxFiles(resolve(process.cwd(), "src"))
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

describe("tours", () => {
  it("has a tour for every key of TOURS, with unique tour ids", () => {
    const ids = TOUR_LIST.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [key, tour] of Object.entries(TOURS)) expect(tour.id).toBe(key);
  });

  it("has unique step ids within each tour and at least one step", () => {
    for (const tour of TOUR_LIST) {
      expect(tour.steps.length).toBeGreaterThan(0);
      const ids = tour.steps.map((s) => s.id);
      expect(new Set(ids).size, tour.id).toBe(ids.length);
    }
  });

  it("points every step at a data-tour attribute that exists in the UI", () => {
    for (const tour of TOUR_LIST) {
      for (const step of tour.steps) {
        const attr = new RegExp(
          `(?:data-tour|tour)=(?:"${step.target}"|\\{\\s*"${step.target}"\\s*\\}|\\{\\s*'${step.target}'\\s*\\})`,
        );
        expect(attr.test(source), `${tour.id}/${step.id} -> ${step.target}`).toBe(true);
      }
    }
  });

  it("starts the main tour at the open-file control", () => {
    expect(TOURS.main.steps[0]?.target).toBe("open-file");
  });

  it("shows the repeat count, the score menu and playing from the cursor in Edit mode (#228)", () => {
    const steps = TOURS.editing.steps;
    const ids = steps.map((s) => s.id);
    expect(ids.slice(ids.indexOf("palette"), ids.indexOf("history") + 1)).toEqual([
      "palette",
      "repeat-end",
      "score-menu",
      "play-from-cursor",
      "history",
    ]);
    const step = (id: string) => steps.find((s) => s.id === id);
    expect(step("repeat-end")).toMatchObject({ target: "repeat-end", show: { editing: true } });
    expect(step("score-menu")).toMatchObject({ target: "score", show: { editing: true } });
    expect(step("score-menu")?.body).toMatch(/Insert rest before.*Insert rest after.*Repeat end/);
    expect(step("play-from-cursor")).toMatchObject({ target: "play", show: { editing: true } });
  });
});

describe("feature registry", () => {
  it("has unique ids", () => {
    const ids = FEATURE_REGISTRY.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses major.minor.patch versions", () => {
    for (const f of FEATURE_REGISTRY) expect(f.since, f.id).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("only names tours that exist", () => {
    for (const f of FEATURE_REGISTRY) {
      if (f.tour !== undefined) expect(TOURS[f.tour], f.id).toBeDefined();
    }
  });

  it("explains stems as lanes in the audio lanes tour, on a control the tour can point to", () => {
    const step = TOURS["audio-lanes"].steps.find((x) => x.id === "stems");
    expect(step?.body).toMatch(/Add to a tab/);
    expect(source).toContain(`data-tour="${step?.target}"`);
    // The registry entry for stem export opens this tour.
    expect(FEATURE_REGISTRY.find((x) => x.id === "stem-export")?.tour).toBe("audio-lanes");
  });
});
