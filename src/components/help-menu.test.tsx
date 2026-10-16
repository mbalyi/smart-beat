import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

  describe("tours and demo song", () => {
    const open = async (props: Partial<React.ComponentProps<typeof HelpMenu>> = {}) => {
      const onAction = vi.fn();
      const utils = renderWithProviders(
        <HelpMenu onSelect={vi.fn()} onAction={onAction} {...props} />,
      );
      await utils.user.click(screen.getByRole("button", { name: "Help" }));
      await screen.findByRole("menu");
      return { ...utils, onAction };
    };

    it("starts the main tour", async () => {
      const { user, onAction } = await open();
      await user.click(screen.getByRole("menuitem", { name: "Take the Tour" }));
      expect(onAction).toHaveBeenCalledExactlyOnceWith({ tour: "main" });
    });

    it("offers to continue an interrupted tour", async () => {
      const { user, onAction } = await open({ resumeStep: 3 });
      expect(screen.queryByRole("menuitem", { name: "Take the Tour" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("menuitem", { name: "Continue the Tour" }));
      expect(onAction).toHaveBeenCalledExactlyOnceWith({ tour: "main" });
    });

    it("lists the other tours in a Tours submenu", async () => {
      const { user, onAction } = await open();
      await user.click(screen.getByRole("menuitem", { name: "Tours" }));
      for (const name of [
        "Editing tour",
        "Speed Trainer tour",
        "Effects tour",
        "Record to tab tour",
      ]) {
        expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
      }
      screen.getByRole("menuitem", { name: "Effects tour" }).focus();
      await user.keyboard("{Enter}");
      expect(onAction).toHaveBeenCalledExactlyOnceWith({ tour: "effects" });
    });

    it.each([
      ["Open Demo Song", "demo-song"],
      ["What’s New", "whats-new"],
      ["Reset Tips", "reset-tips"],
    ])("%s calls the %s action", async (label, action) => {
      const { user, onAction } = await open();
      await user.click(screen.getByRole("menuitem", { name: label }));
      expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
    });

    it("leaves the items out without onAction", async () => {
      renderWithProviders(<HelpMenu onSelect={vi.fn()} />);
      await userEvent.setup().click(screen.getByRole("button", { name: "Help" }));
      await screen.findByRole("menu");
      for (const name of [/tour/i, /demo/i, /new/i, /tips/i]) {
        expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
      }
    });

    it("has no accessibility violations with the menu open", async () => {
      await open();
      await expectNoA11yViolations();
    });
  });
});
