import { screen } from "@testing-library/react";

import { AboutDialog } from "@/components/about-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { APP_INFO, mockTauri } from "@/test/tauri";

function renderAbout() {
  const onOpenChange = vi.fn();
  return { ...renderWithProviders(<AboutDialog open onOpenChange={onOpenChange} />), onOpenChange };
}

describe("AboutDialog", () => {
  it("shows version details from the Rust core", async () => {
    mockTauri();
    renderAbout();

    const dialog = screen.getByRole("dialog", { name: "Smart Beat" });
    expect(dialog).toHaveAccessibleDescription(/self-hosted AI tools/);
    expect(await screen.findByText(APP_INFO.version)).toBeInTheDocument();
    expect(screen.getByText("macOS (Apple Silicon)")).toBeInTheDocument();
    expect(screen.getByText(APP_INFO.tauriVersion)).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("links the project's contact address and source code", async () => {
    mockTauri();
    renderAbout();

    const contact = await screen.findByRole("link", { name: "smart-beat@outlook.com" });
    expect(contact).toHaveAttribute("href", "mailto:smart-beat@outlook.com");
    expect(screen.getByRole("link", { name: "github.com/mbalyi/smart-beat" })).toHaveAttribute(
      "href",
      "https://github.com/mbalyi/smart-beat",
    );
    expect(screen.getByRole("link", { name: "@mbalyi" })).toHaveAttribute(
      "href",
      "https://github.com/mbalyi",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /© \d{4} @mbalyi\. Source code under PolyForm Noncommercial 1\.0\.0\./,
    );
  });

  it("announces loading, then an error when details are unavailable", async () => {
    renderAbout();

    expect(screen.getByRole("status")).toHaveTextContent("Loading version details");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Version details are unavailable\. This feature is only available in the Smart Beat desktop app/,
    );
  });

  it("closes with Escape and the close buttons", async () => {
    mockTauri();
    const { user, onOpenChange } = renderAbout();

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons).toHaveLength(2);
    await user.click(closeButtons[0]!);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });
});
