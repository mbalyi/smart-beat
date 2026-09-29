import { screen, within } from "@testing-library/react";

import { Welcome } from "@/components/welcome";
import { FEATURES } from "@/components/welcome-features";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function renderWelcome() {
  const onOpenFile = vi.fn();
  const onShowShortcuts = vi.fn();
  const utils = renderWithProviders(
    <Welcome onOpenFile={onOpenFile} onShowShortcuts={onShowShortcuts} />,
  );
  return { ...utils, onOpenFile, onShowShortcuts };
}

describe("Welcome", () => {
  it("has one h1 and a logical heading order", () => {
    renderWelcome();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Features" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(FEATURES.length);
  });

  it("lists every upcoming feature", () => {
    renderWelcome();

    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(FEATURES.length);
    for (const feature of FEATURES) {
      expect(within(list).getByRole("heading", { name: feature.title })).toBeInTheDocument();
    }
  });

  it("wires up the primary actions", async () => {
    const { user, onOpenFile, onShowShortcuts } = renderWelcome();

    await user.click(screen.getByRole("button", { name: "Open a file…" }));
    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    expect(onOpenFile).toHaveBeenCalledOnce();
    expect(onShowShortcuts).toHaveBeenCalledOnce();
  });

  it("has no accessibility violations", async () => {
    renderWelcome();
    await expectNoA11yViolations();
  });
});
