import { describe, expect, it } from "vitest";

import { drumLineAtY, tabLineAtY } from "@/lib/score/drum-lines";

describe("drumLineAtY (#228)", () => {
  // Six lines from y = 100 (top line, 6) to y = 150 (bottom line, 1): 10 px apart.
  const bar = { y: 100, h: 50 };

  it("finds the line nearest to a click, top line first", () => {
    expect(drumLineAtY(bar, 100)).toBe(6);
    expect(drumLineAtY(bar, 104)).toBe(6);
    expect(drumLineAtY(bar, 126)).toBe(3);
    expect(drumLineAtY(bar, 150)).toBe(1);
  });

  it("takes a click just above or below the staff as the outer line", () => {
    expect(drumLineAtY(bar, 96)).toBe(6);
    expect(drumLineAtY(bar, 154)).toBe(1);
  });

  it("is null for a click well away from the drum tab", () => {
    expect(drumLineAtY(bar, 80)).toBeNull();
    expect(drumLineAtY(bar, 170)).toBeNull();
  });
});

describe("tabLineAtY (#228)", () => {
  // Four lines (a bass) from y = 100 (top line, 4) to y = 130 (bottom line, 1): 10 px apart.
  const bar = { y: 100, h: 30 };

  it("finds the line nearest to a click on a tab of any number of lines", () => {
    expect(tabLineAtY(bar, 100, 4)).toBe(4);
    expect(tabLineAtY(bar, 116, 4)).toBe(2);
    expect(tabLineAtY(bar, 130, 4)).toBe(1);
    expect(tabLineAtY({ y: 100, h: 70 }, 150, 8)).toBe(3);
  });

  it("is null away from the staff, and for a tab without a staff to click", () => {
    expect(tabLineAtY(bar, 90, 4)).toBeNull();
    expect(tabLineAtY(bar, 140, 4)).toBeNull();
    expect(tabLineAtY(bar, 100, 1)).toBeNull();
  });
});
