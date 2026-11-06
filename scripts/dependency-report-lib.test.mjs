import { describe, expect, it } from "vitest";

import {
  bumpKind,
  issueTitle,
  outdatedActions,
  parseActionUses,
  parseCargoOutdated,
  parsePnpmOutdated,
  renderReport,
  REPORT_MARKER,
  totalOutdated,
} from "./dependency-report-lib.mjs";

describe("bumpKind", () => {
  it("names the biggest changed part", () => {
    expect(bumpKind("1.2.3", "2.0.0")).toBe("major");
    expect(bumpKind("1.2.3", "1.3.0")).toBe("minor");
    expect(bumpKind("1.2.3", "1.2.4")).toBe("patch");
    expect(bumpKind("v6", "v7.1.0")).toBe("major");
  });
});

describe("parsePnpmOutdated", () => {
  it("lists packages sorted by name and skips ones without a newer version", () => {
    const rows = parsePnpmOutdated({
      vite: { current: "7.0.0", latest: "8.0.0", dependencyType: "devDependencies" },
      react: { current: "19.1.0", latest: "19.2.0", dependencyType: "dependencies" },
      same: { current: "1.0.0", latest: "1.0.0" },
    });
    expect(rows.map((row) => [row.name, row.bump])).toEqual([
      ["react", "minor"],
      ["vite", "major"],
    ]);
  });

  it("handles empty output", () => {
    expect(parsePnpmOutdated({})).toEqual([]);
  });
});

describe("parseCargoOutdated", () => {
  it("skips crates with no known latest version", () => {
    const rows = parseCargoOutdated({
      dependencies: [
        { name: "serde", project: "1.0.200", latest: "1.0.210", kind: "Normal" },
        { name: "gone", project: "1.0.0", latest: "---", kind: "Normal" },
        { name: "uptodate", project: "2.0.0", latest: "2.0.0", kind: "Normal" },
      ],
    });
    expect(rows).toEqual([
      { name: "serde", current: "1.0.200", latest: "1.0.210", kind: "Normal", bump: "patch" },
    ]);
  });
});

describe("actions", () => {
  const workflow = `
jobs:
  a:
    steps:
      - uses: actions/checkout@v7
      - uses: ./local-action
      - uses: pnpm/action-setup@v6
        with: { x: 1 }
      - uses: actions/checkout@v7
`;

  it("finds unique remote uses", () => {
    expect(parseActionUses([workflow])).toEqual([
      { action: "actions/checkout", ref: "v7" },
      { action: "pnpm/action-setup", ref: "v6" },
    ]);
  });

  it("reports only a newer major", () => {
    const uses = parseActionUses([workflow]);
    const rows = outdatedActions(uses, {
      "actions/checkout": "v7.1.0",
      "pnpm/action-setup": "v7.0.0",
    });
    expect(rows.map((row) => row.name)).toEqual(["pnpm/action-setup"]);
  });
});

describe("renderReport", () => {
  const empty = { npm: [], cargo: [], actions: [] };

  it("starts with the marker and counts sections", () => {
    const body = renderReport(
      { ...empty, npm: [{ name: "vite", current: "7.0.0", latest: "8.0.0", bump: "major" }] },
      "https://example.test/run/1",
    );
    expect(body.startsWith(REPORT_MARKER)).toBe(true);
    expect(body).toContain("## npm (1)");
    expect(body).toContain("| `vite` | 7.0.0 | 8.0.0 | major |");
    expect(body).toContain("## Cargo (0)");
    expect(body).toContain("https://example.test/run/1");
  });

  it("totals all sections", () => {
    expect(totalOutdated({ npm: [1], cargo: [1, 2], actions: [] })).toBe(3);
  });
});

describe("issueTitle", () => {
  it("uses the ISO date", () => {
    expect(issueTitle(new Date("2026-11-09T06:00:00Z"))).toBe(
      "Dependency updates, week of 2026-11-09",
    );
  });
});
