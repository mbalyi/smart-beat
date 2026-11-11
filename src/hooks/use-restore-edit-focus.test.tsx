import { render, waitFor } from "@testing-library/react";
import { useRef } from "react";

import { keepsFocus, useRestoreEditFocus } from "@/hooks/use-restore-edit-focus";

function Song({ active, editing }: { active: boolean; editing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useRestoreEditFocus(ref, { active, editing });
  // Like the score: a scrollable region that takes the keys.
  return <div ref={ref} role="region" aria-label="Score" tabIndex={0} data-testid="score" />;
}

/** Lets a pending animation frame run. */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function setup(initial: { active: boolean; editing: boolean }) {
  const utils = render(<Song {...initial} />);
  const show = (props: { active: boolean; editing: boolean }) =>
    utils.rerender(<Song {...props} />);
  return { ...utils, show, score: () => utils.getByTestId("score") };
}

describe("useRestoreEditFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses the score when the tab is shown again in edit mode", async () => {
    // Arrange
    const { show, score } = setup({ active: true, editing: true });
    show({ active: false, editing: true });
    expect(score()).not.toHaveFocus();

    // Act
    show({ active: true, editing: true });

    // Assert
    await waitFor(() => expect(score()).toHaveFocus());
  });

  it("leaves focus alone outside edit mode", async () => {
    const { show, score } = setup({ active: false, editing: false });

    show({ active: true, editing: false });
    await nextFrame();

    expect(score()).not.toHaveFocus();
  });

  it("does not take focus on mount or while the tab stays shown", async () => {
    const { show, score } = setup({ active: true, editing: true });
    await nextFrame();
    expect(score()).not.toHaveFocus();

    show({ active: true, editing: true });
    await nextFrame();

    expect(score()).not.toHaveFocus();
  });

  it("leaves a dialog or text field that has focus alone", async () => {
    const { show, score } = setup({ active: false, editing: true });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = "<button>Keep</button>";
    document.body.append(dialog);
    dialog.querySelector("button")!.focus();

    show({ active: true, editing: true });
    await nextFrame();

    expect(score()).not.toHaveFocus();
    expect(dialog.querySelector("button")).toHaveFocus();
  });
});

describe("keepsFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps text fields, dialogs and menus, not buttons or nothing", () => {
    document.body.innerHTML = `
      <input id="field" /><textarea id="area"></textarea><div id="editable" contenteditable="true"></div>
      <div role="dialog"><button id="in-dialog">OK</button></div>
      <div role="menu"><div id="item" role="menuitem"></div></div>
      <button id="tab">Song</button>`;
    const byId = (id: string) => document.getElementById(id);

    for (const id of ["field", "area", "editable", "in-dialog", "item"]) {
      expect(keepsFocus(byId(id))).toBe(true);
    }
    expect(keepsFocus(byId("tab"))).toBe(false);
    expect(keepsFocus(null)).toBe(false);
    expect(keepsFocus(document.body)).toBe(false);
  });

  it("lets focus left behind in a hidden (inert) song move", () => {
    document.body.innerHTML = `<div inert><input id="field" /></div>`;

    expect(keepsFocus(document.getElementById("field"))).toBe(false);
  });
});
