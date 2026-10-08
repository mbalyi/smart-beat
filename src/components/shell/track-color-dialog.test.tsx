import { screen, within } from "@testing-library/react";

import { TrackColorDialog } from "@/components/shell/track-color-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(props: Partial<Parameters<typeof TrackColorDialog>[0]> = {}) {
  const onChange = vi.fn();
  const onResetAll = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <TrackColorDialog
      open
      onOpenChange={onOpenChange}
      trackName="Bass (Sam Rivers)"
      index={1}
      color={null}
      anyCustom={false}
      onChange={onChange}
      onResetAll={onResetAll}
      {...props}
    />,
  );
  return { ...utils, onChange, onResetAll, onOpenChange };
}

describe("TrackColorDialog (#83)", () => {
  it("offers a palette of named colours and sends the one picked", async () => {
    const { user, onChange } = setup();
    const palette = screen.getByRole("group", { name: "Colours" });
    expect(within(palette).getAllByRole("button").length).toBeGreaterThanOrEqual(8);
    await user.click(within(palette).getByRole("button", { name: "Blue" }));
    expect(onChange).toHaveBeenLastCalledWith("#3e63dd");
    await expectNoA11yViolations();
  });

  it("marks the chosen swatch without relying on its colour", () => {
    setup({ color: "#3E63DD", anyCustom: true });
    const blue = screen.getByRole("button", { name: "Blue" });
    expect(blue).toHaveAttribute("aria-pressed", "true");
    expect(blue.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Custom colour #3e63dd")).toBeInTheDocument();
  });

  it("takes any colour from the picker", () => {
    const { onChange } = setup();
    const picker = screen.getByLabelText("Another colour");
    // React listens to `input`; jsdom's colour input accepts a valid value.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      picker,
      "#112233",
    );
    picker.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith("#112233");
  });

  it("goes back to the default colour of the track, or of every track", async () => {
    const { user, onChange, onResetAll } = setup({ color: "#e5484d", anyCustom: true });
    await user.click(screen.getByRole("button", { name: "Default colour" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    await user.click(screen.getByRole("button", { name: "Reset all colours" }));
    expect(onResetAll).toHaveBeenCalledTimes(1);
  });

  it("has nothing to reset while every track has its default colour", () => {
    setup();
    expect(screen.getByRole("button", { name: "Default colour" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset all colours" })).toBeDisabled();
    expect(screen.getByText("Default colour", { selector: "span" })).toBeInTheDocument();
  });
});
