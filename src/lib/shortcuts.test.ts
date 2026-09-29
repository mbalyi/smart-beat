import { groupByMenu } from "@/lib/shortcuts";
import { SHORTCUTS } from "@/test/tauri";

describe("groupByMenu", () => {
  it("groups shortcuts by menu in first-seen order", () => {
    const groups = groupByMenu(SHORTCUTS);

    expect(groups.map(([menu]) => menu)).toEqual(["File", "View", "Help"]);
    expect(groups[0]?.[1].map((s) => s.action)).toEqual(["open", "quit"]);
  });

  it("returns no groups for no shortcuts", () => {
    expect(groupByMenu([])).toEqual([]);
  });
});
