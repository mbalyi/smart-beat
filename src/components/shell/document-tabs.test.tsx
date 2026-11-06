import { screen, within } from "@testing-library/react";

import { DocumentTabs } from "@/components/shell/document-tabs";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(activeId: number | null = 2) {
  const handlers = { onActivate: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };
  const utils = renderWithProviders(
    <DocumentTabs
      tabs={[
        { id: 1, title: "First", edited: false },
        { id: 2, title: "Second", edited: true },
      ]}
      activeId={activeId}
      {...handlers}
    />,
  );
  return { ...utils, ...handlers };
}

describe("DocumentTabs", () => {
  it("lists the open songs and marks the shown one and the edited ones", async () => {
    setup();

    const nav = screen.getByRole("navigation", { name: "Open songs" });
    expect(within(nav).getAllByRole("listitem")).toHaveLength(2);
    expect(within(nav).getByRole("button", { name: "First" })).not.toHaveAttribute("aria-current");
    expect(within(nav).getByRole("button", { name: "Second (edited)" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expectNoA11yViolations();
  });

  it("switches, closes and starts a new song", async () => {
    const { user, onActivate, onClose, onNew } = setup();

    await user.click(screen.getByRole("button", { name: "First" }));
    await user.click(screen.getByRole("button", { name: "Close Second" }));
    await user.click(screen.getByRole("button", { name: "New song" }));

    expect(onActivate).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalledWith(2);
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("puts every tab and close button in the keyboard order", async () => {
    const { user } = setup();

    await user.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close First" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Second (edited)" })).toHaveFocus();
  });
});

describe("DocumentTabs: other kinds of document", () => {
  it("mixes numbered songs and named documents, with an icon, a list name and a + label", async () => {
    const onNew = vi.fn();
    const onActivate = vi.fn();
    const { user } = renderWithProviders(
      <DocumentTabs
        tabs={[
          { id: 1, title: "Song", edited: false },
          { id: "stem-1", title: "Separated", edited: false, icon: <svg data-testid="kind" /> },
        ]}
        activeId="stem-1"
        onActivate={onActivate}
        onClose={vi.fn()}
        onNew={onNew}
        label="Open songs and stems"
        newLabel="New stem separation"
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Open songs and stems" });
    expect(within(nav).getByRole("button", { name: "Separated" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(nav).getByTestId("kind")).toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "Separated" }));
    expect(onActivate).toHaveBeenCalledWith("stem-1");
    const plus = within(nav).getByRole("button", { name: "New stem separation" });
    await user.click(plus);
    expect(onNew).toHaveBeenCalledWith(plus);
  });
});
