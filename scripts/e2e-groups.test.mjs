import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CI_GROUPS, FEATURE_GROUPS, SMOKE_GROUPS } from "../e2e/groups.ts";

/** The spec files in e2e/ (the glob `**` + `/name.spec.ts` of a group matches by file name). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPECS = readdirSync(join(ROOT, "e2e")).filter((f) => f.endsWith(".spec.ts"));

/** A group glob like `**\/practice-together*.spec.ts` as a test on a bare file name. */
function matcher(glob) {
  const name = glob.replace(/^\*\*\//, "");
  const source = name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${source}$`);
}

const groupsIn = (groups, spec) =>
  Object.entries(groups)
    .filter(([, globs]) => globs.some((glob) => matcher(glob).test(spec)))
    .map(([group]) => group);
const groupsOf = (spec) => groupsIn(FEATURE_GROUPS, spec);

describe("e2e groups", () => {
  it("puts no spec in two feature groups", () => {
    const shared = SPECS.map((spec) => [spec, groupsOf(spec)]).filter(([, g]) => g.length > 1);
    expect(shared).toEqual([]);
  });

  it("has a spec for every glob, so a renamed spec does not drop out of its group", () => {
    const unused = [...Object.values(FEATURE_GROUPS), ...Object.values(SMOKE_GROUPS)]
      .flat()
      .filter((glob) => !SPECS.some((spec) => matcher(glob).test(spec)));
    expect(unused).toEqual([]);
  });

  it("runs the groups CI lists, and only those", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const listed = [...ci.matchAll(/^\s+- \{ id: ([a-z-]+),/gm)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...CI_GROUPS].sort());
  });

  it("puts every spec in no feature group into exactly one smoke theme", () => {
    const core = SPECS.filter((spec) => groupsOf(spec).length === 0);
    const unassigned = core.filter((spec) => groupsIn(SMOKE_GROUPS, spec).length !== 1);
    expect(unassigned).toEqual([]);
  });

  it("keeps feature specs out of the smoke themes", () => {
    const stray = SPECS.filter(
      (spec) => groupsOf(spec).length > 0 && groupsIn(SMOKE_GROUPS, spec).length > 0,
    );
    expect(stray).toEqual([]);
  });

  it("keeps smoke as the rest: some specs are in no feature group", () => {
    expect(SPECS.filter((spec) => groupsOf(spec).length === 0).length).toBeGreaterThan(0);
  });
});
