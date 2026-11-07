import { screen, within } from "@testing-library/react";

import { PracticeTogetherLauncher } from "@/components/practice-together/practice-together-launcher";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function renderLauncher(recent: string[] = ["/Songs/riff.gp5", "/Band/Intro.gp"]) {
  const handlers = { onOpenChange: vi.fn(), onStart: vi.fn(), onJoin: vi.fn() };
  const utils = renderWithProviders(
    <PracticeTogetherLauncher open recent={recent} {...handlers} />,
  );
  return { ...utils, ...handlers };
}

describe("PracticeTogetherLauncher", () => {
  it("asks first whether to start a new session or join one", () => {
    renderLauncher();
    expect(screen.getByRole("dialog", { name: "Practice together" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Start a new session" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Join an existing session" })).not.toBeChecked();
  });

  it("joins without picking a tab: it comes from the host", async () => {
    const { user, onJoin, onStart, onOpenChange } = renderLauncher();
    await user.click(screen.getByRole("radio", { name: "Join an existing session" }));
    expect(screen.getByText(/the tab comes from the host/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Join a session" }));
    expect(onJoin).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("picks a tab first for a new session, from the recent songs", async () => {
    const { user, onStart, onJoin } = renderLauncher();
    await user.click(screen.getByRole("button", { name: "Pick a tab" }));
    const list = screen.getByRole("list", { name: "Recent songs" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: /Intro\.gp/ }));
    expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "recent", path: "/Band/Intro.gp" });
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("starts a new session on a file or a blank tab", async () => {
    const { user, onStart } = renderLauncher([]);
    await user.click(screen.getByRole("button", { name: "Pick a tab" }));
    expect(screen.queryByRole("list", { name: "Recent songs" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open a file…" }));
    expect(onStart).toHaveBeenLastCalledWith({ kind: "file" });
    await user.click(screen.getByRole("button", { name: "Pick a tab" }));
    await user.click(screen.getByRole("button", { name: "New blank tab" }));
    expect(onStart).toHaveBeenLastCalledWith({ kind: "blank" });
  });

  it("goes back from the tab step to the choice", async () => {
    const { user } = renderLauncher();
    await user.click(screen.getByRole("button", { name: "Pick a tab" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("radio", { name: "Start a new session" })).toBeInTheDocument();
  });

  it("shows four steps for a new session and three for joining", async () => {
    const { user } = renderLauncher();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(4);
    await user.click(screen.getByRole("radio", { name: "Join an existing session" }));
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
  });

  it("has no accessibility violations", async () => {
    renderLauncher();
    await expectNoA11yViolations(screen.getByRole("dialog"));
  });
});
