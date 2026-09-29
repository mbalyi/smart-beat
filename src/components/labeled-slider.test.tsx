import { screen } from "@testing-library/react";

import { LabeledSlider } from "@/components/labeled-slider";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(props: Partial<Parameters<typeof LabeledSlider>[0]> = {}) {
  const onValueChange = vi.fn();
  const onValueCommit = vi.fn();
  const utils = renderWithProviders(
    <LabeledSlider
      label="Pan, Bass"
      valueText="Centre"
      value={0}
      min={-1}
      max={1}
      step={0.25}
      onValueChange={onValueChange}
      onValueCommit={onValueCommit}
      {...props}
    />,
  );
  return { ...utils, onValueChange, onValueCommit };
}

describe("LabeledSlider", () => {
  it("names the thumb and speaks the value", async () => {
    setup();

    const slider = screen.getByRole("slider", { name: "Pan, Bass" });
    expect(slider).toHaveAttribute("aria-valuetext", "Centre");
    expect(slider).toHaveAttribute("aria-valuemin", "-1");
    expect(slider).toHaveAttribute("aria-valuemax", "1");
    await expectNoA11yViolations();
  });

  it("changes and commits with the keyboard", async () => {
    const { user, onValueChange, onValueCommit } = setup();

    screen.getByRole("slider").focus();
    await user.keyboard("{ArrowRight}");

    expect(onValueChange).toHaveBeenCalledWith(0.25);
    expect(onValueCommit).toHaveBeenCalledWith(0.25);
  });

  it("can be disabled", () => {
    setup({ disabled: true });
    expect(screen.getByRole("slider")).toHaveAttribute("data-disabled");
  });
});
