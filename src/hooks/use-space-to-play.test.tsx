import { fireEvent, renderHook } from "@testing-library/react";

import { isInteractiveTarget, useSpaceToPlay } from "@/hooks/use-space-to-play";

function press(target: Element | Document | Window, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key: " ", code: "Space", ...init });
}

describe("useSpaceToPlay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("toggles playback when Space is pressed outside controls", () => {
    const toggle = vi.fn();
    renderHook(() => useSpaceToPlay(toggle));

    const notPrevented = press(document.body);

    expect(toggle).toHaveBeenCalledOnce();
    expect(notPrevented).toBe(false); // the page does not scroll
  });

  it("plays also when a button, toggle or slider has focus", () => {
    const toggle = vi.fn();
    renderHook(() => useSpaceToPlay(toggle));
    document.body.innerHTML = `
      <button>Count-in</button><input type="checkbox" /><div role="slider" tabindex="0"></div>`;

    for (const el of document.body.querySelectorAll("button, input, [role=slider]")) {
      expect(press(el)).toBe(false);
    }

    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it("leaves Space to text fields, open lists and dialogs", () => {
    const toggle = vi.fn();
    renderHook(() => useSpaceToPlay(toggle));
    document.body.innerHTML = `
      <input /><input type="number" /><textarea></textarea>
      <div contenteditable="true"><span id="inner">text</span></div>
      <div role="listbox"><div role="option" id="opt">A</div></div>`;

    for (const el of document.body.querySelectorAll("input, textarea, #inner, #opt")) {
      press(el);
    }
    document.body.innerHTML = `<div role="dialog"><button>Done</button></div><button id="x">x</button>`;
    press(document.getElementById("x")!);
    press(document.querySelector("[role=dialog] button")!);

    expect(toggle).not.toHaveBeenCalled();
  });

  it("ignores modified, repeated and other keys", () => {
    const toggle = vi.fn();
    renderHook(() => useSpaceToPlay(toggle));

    press(document.body, { ctrlKey: true });
    press(document.body, { shiftKey: true });
    press(document.body, { repeat: true });
    fireEvent.keyDown(document.body, { key: "Enter" });

    expect(toggle).not.toHaveBeenCalled();
  });

  it("does nothing while disabled or after unmount", () => {
    const toggle = vi.fn();
    const { rerender, unmount } = renderHook(({ enabled }) => useSpaceToPlay(toggle, enabled), {
      initialProps: { enabled: false },
    });

    press(document.body);
    rerender({ enabled: true });
    press(document.body);
    unmount();
    press(document.body);

    expect(toggle).toHaveBeenCalledOnce();
  });
});

describe("isInteractiveTarget", () => {
  it("treats non-elements as not interactive", () => {
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget(window)).toBe(false);
  });
});
