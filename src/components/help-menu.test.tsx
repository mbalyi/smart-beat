import { screen } from "@testing-library/react";

import { HelpMenu } from "@/components/help-menu";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("HelpMenu", () => {
  it.each([
    ["Keyboard Shortcuts", "shortcuts"],
    ["Open-Source Licenses", "licenses"],
    ["About Smart Beat", "about"],
  ])("selecting %s opens the %s dialog", async (label, dialog) => {
    const onSelect = vi.fn();
    const { user } = renderWithProviders(<HelpMenu onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(await screen.findByRole("menuitem", { name: label }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(
      dialog,
      screen.getByRole("button", { name: "Help" }),
    );
  });

  it("is keyboard operable and accessible", async () => {
    const onSelect = vi.fn();
    const { user } = renderWithProviders(<HelpMenu onSelect={onSelect} />);

    screen.getByRole("button", { name: "Help" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await expectNoA11yViolations();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
