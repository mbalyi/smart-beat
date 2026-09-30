import { screen, within } from "@testing-library/react";

import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

describe("ShortcutsDialog", () => {
  it("lists the platform shortcuts grouped by menu", async () => {
    mockTauri();
    renderWithProviders(<ShortcutsDialog open onOpenChange={() => {}} />);

    const file = await screen.findByRole("region", { name: "File" });
    expect(within(file).getByText("Open…")).toBeInTheDocument();
    expect(within(file).getByText("Quit Smart Beat")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Help" })).toBeInTheDocument();
  });

  it("renders key caps visually and spells them out for screen readers", async () => {
    mockTauri();
    renderWithProviders(<ShortcutsDialog open onOpenChange={() => {}} />);

    const spoken = await screen.findByText("Shift+Command+L");
    expect(spoken).toHaveClass("sr-only");
    const caps = spoken.previousElementSibling as HTMLElement;
    expect(caps).toHaveAttribute("aria-hidden", "true");
    expect(caps).toHaveTextContent("⇧⌘L");
    await expectNoA11yViolations();
  });

  it("lists the score editor's keys", async () => {
    mockTauri();
    renderWithProviders(<ShortcutsDialog open onOpenChange={() => {}} />);

    const editor = await screen.findByRole("region", { name: "Score editor (Edit mode)" });
    expect(within(editor).getByText("Type a fret (two quick digits: 10–29)")).toBeInTheDocument();
    expect(within(editor).getByText("Copy / cut / paste")).toBeInTheDocument();
  });

  it("explains when shortcuts are unavailable", async () => {
    renderWithProviders(<ShortcutsDialog open onOpenChange={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Shortcuts are unavailable.");
  });
});
