import { screen } from "@testing-library/react";

import { ThemeToggle } from "@/components/theme-toggle";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("ThemeToggle", () => {
  it("has an accessible name", async () => {
    renderWithProviders(<ThemeToggle />);

    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("switches theme from the menu with the keyboard", async () => {
    const { user } = renderWithProviders(<ThemeToggle />);

    screen.getByRole("button", { name: "Theme" }).focus();
    await user.keyboard("{Enter}");
    const dark = await screen.findByRole("menuitemradio", { name: "Dark" });
    expect(screen.getByRole("menuitemradio", { name: "System" })).toBeChecked();

    await user.click(dark);

    expect(document.documentElement).toHaveClass("dark");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("marks the active choice", async () => {
    const { user } = renderWithProviders(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Theme" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Light" }));
    await user.click(screen.getByRole("button", { name: "Theme" }));

    expect(await screen.findByRole("menuitemradio", { name: "Light" })).toBeChecked();
    await expectNoA11yViolations();
  });
});
