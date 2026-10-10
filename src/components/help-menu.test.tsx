import { screen } from "@testing-library/react";

import { HelpMenu } from "@/components/help-menu";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("HelpMenu", () => {
  it.each([
    ["Keyboard Shortcuts", "shortcuts"],
    ["Settings…", "settings"],
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

  it("lists Check for Updates… only when the app can update itself", async () => {
    const onCheckForUpdates = vi.fn();
    const { user, unmount } = renderWithProviders(
      <HelpMenu onSelect={vi.fn()} onCheckForUpdates={onCheckForUpdates} />,
    );

    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for Updates…" }));
    expect(onCheckForUpdates).toHaveBeenCalledOnce();
    unmount();

    // In a browser there is nothing to update.
    const browser = renderWithProviders(<HelpMenu onSelect={vi.fn()} />);
    await browser.user.click(screen.getByRole("button", { name: "Help" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: /updates/i })).not.toBeInTheDocument();
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
