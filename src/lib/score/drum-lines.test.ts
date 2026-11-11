import { describe, expect, it } from "vitest";

import { drumLineAtY } from "@/lib/score/drum-lines";

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
