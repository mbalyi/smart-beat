import { screen } from "@testing-library/react";

import { BarProblems } from "@/components/score/bar-problems";
import type { BarProblem } from "@/lib/score/bar-duration";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const problem = (bar: number, actual: number, expected = 3840): BarProblem => ({
  bar,
  track: 0,
  voice: 0,
  actual,
  expected,
});

function setup(problems: BarProblem[]) {
  const onFix = vi.fn();
  const onGoTo = vi.fn();
  const utils = renderWithProviders(
    <BarProblems problems={problems} onFix={onFix} onGoTo={onGoTo} />,
  );
  return { ...utils, onFix, onGoTo };
}

describe("BarProblems", () => {
  it("shows nothing when all bars are right", () => {
    setup([]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("names a short bar and how to fix it", async () => {
    const { user, onFix, onGoTo } = setup([problem(1, 2880)]);
    const banner = screen.getByRole("status", { name: "Bar lengths" });
    expect(banner).toHaveTextContent("Bar 2 is 1 beat too short — it can be filled with rests.");
    await expectNoA11yViolations();
    await user.click(screen.getByRole("button", { name: "Fix bar" }));
    await user.click(screen.getByRole("button", { name: "Go to bar 2" }));
    expect(onFix).toHaveBeenCalledOnce();
    expect(onGoTo).toHaveBeenCalledWith(1);
  });

  it("names a long bar and says it is trimmed", () => {
    setup([problem(0, 4800)]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Bar 1 is 1 beat too long — it can be trimmed.",
    );
  });

  it("lists the first bars of many and counts the rest, once per bar", () => {
    setup(
      [0, 1, 2, 3, 4, 5].flatMap((bar) => [problem(bar, 960), { ...problem(bar, 960), voice: 1 }]),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "6 bars have the wrong length: 1, 2, 3, 4 and 2 more",
    );
    expect(screen.getByRole("button", { name: "Fix all" })).toBeInTheDocument();
  });
});
