import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TooltipRenderProps } from "react-joyride";

import { CoachMark } from "@/components/tour/coach-mark";
import { expectNoA11yViolations } from "@/test/axe";

function setup(
  overrides: { index?: number; size?: number; isLastStep?: boolean; canGoBack?: boolean } = {},
) {
  const back = vi.fn();
  const primary = vi.fn();
  const skip = vi.fn();
  const { index = 1, size = 10, isLastStep = false, canGoBack = true } = overrides;
  const props = {
    index,
    size,
    isLastStep,
    step: {
      title: "Play it",
      content: "Press space to start.",
      data: { canGoBack: () => canGoBack },
    },
    backProps: { onClick: back, role: "button", "data-action": "back" },
    primaryProps: { onClick: primary, role: "button", "data-action": "primary" },
    skipProps: { onClick: skip, role: "button", "data-action": "skip" },
    tooltipProps: { "aria-modal": true, role: "alertdialog" },
  } as unknown as TooltipRenderProps;
  render(<CoachMark {...props} />);
  return { back, primary, skip };
}

describe("CoachMark", () => {
  it("shows the step count, title and body", () => {
    setup();
    expect(screen.getByText("Step 2 of 10")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Play it" })).toBeInTheDocument();
    expect(screen.getByText("Press space to start.")).toBeInTheDocument();
  });

  it("is a non-modal dialog named after its title", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Play it" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(dialog).toHaveAccessibleDescription("Press space to start.");
  });

  it("shows Back only when the tour can go back", () => {
    setup({ canGoBack: false });
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("wires Back, Next and Skip", async () => {
    const { back, primary, skip } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(back).toHaveBeenCalledOnce();
    expect(primary).toHaveBeenCalledOnce();
    expect(skip).toHaveBeenCalledOnce();
  });

  it("says Done on the last step", () => {
    setup({ isLastStep: true, index: 9 });
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("moves focus to Next when it opens", () => {
    setup();
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });

  it("has no accessibility violations", async () => {
    setup();
    await expectNoA11yViolations();
  });
});
