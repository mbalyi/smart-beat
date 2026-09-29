/**
 * Integration tests: the whole UI with the Tauri IPC layer mocked to behave
 * like the Rust core (commands + menu events).
 */
import { act, screen, waitFor, within } from "@testing-library/react";

import { App } from "@/App";
import type { MenuAction } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { APP_INFO, emitMenuAction, mockTauri } from "@/test/tauri";

async function renderApp() {
  const calls = mockTauri();
  const utils = renderWithProviders(<App />);
  // Wait until the menu listener is registered.
  await waitFor(async () => {
    await act(() => emitMenuAction("shortcuts"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  await utils.user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  return { ...utils, calls };
}

async function menu(action: MenuAction) {
  await act(() => emitMenuAction(action));
}

describe("App", () => {
  it("renders the app shell with landmarks", async () => {
    await renderApp();

    expect(screen.getByRole("banner")).toHaveTextContent("Smart Beat");
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    await expectNoA11yViolations(document.body, { page: true });
  });

  it("starts keyboard navigation with a skip link to the main content", async () => {
    const { user } = await renderApp();

    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");

    await user.tab();
    expect(screen.getByRole("button", { name: "Theme" })).toHaveFocus();
  });

  it("Help → About shows version details from the Rust core", async () => {
    const { calls } = await renderApp();

    await menu("about");

    const dialog = await screen.findByRole("dialog", { name: "Smart Beat" });
    expect(await within(dialog).findByText(APP_INFO.version)).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "app_info")).toBe(true);
  });

  it("Help → Keyboard Shortcuts lists shortcuts from the Rust core", async () => {
    await renderApp();

    await menu("shortcuts");

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(await within(dialog).findByText("Toggle Dark Mode")).toBeInTheDocument();
  });

  it("Help → Open-Source Licenses shows the notices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("tauri — MIT OR Apache-2.0")));
    await renderApp();

    await menu("licenses");

    const dialog = await screen.findByRole("dialog", { name: "Open-source licenses" });
    expect(await within(dialog).findByText(/tauri — MIT OR Apache-2.0/)).toBeInTheDocument();
  });

  it("View → Toggle Dark Mode switches the theme and the native title bar", async () => {
    const { calls } = await renderApp();

    await menu("toggle-theme");

    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: "plugin:window|set_theme",
        args: expect.objectContaining({ value: "dark" }),
      }),
    );
  });

  it("File → Open… explains that file support is coming", async () => {
    await renderApp();

    await menu("open");

    expect(await screen.findByText("Opening files is coming soon")).toBeInTheDocument();
  });

  it("ignores actions the Rust core handles natively", async () => {
    await renderApp();

    await menu("zoom-in");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens dialogs from the in-window Help menu and restores focus on close", async () => {
    const { user } = await renderApp();
    const help = screen.getByRole("button", { name: "Help" });

    await user.click(help);
    await user.click(await screen.findByRole("menuitem", { name: "About Smart Beat" }));
    expect(await screen.findByRole("dialog", { name: "Smart Beat" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(help).toHaveFocus();
  });

  it("keeps working in a plain browser without the Rust core", async () => {
    const { user } = renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Shortcuts are unavailable.");
  });
});
