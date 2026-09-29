import { fireEvent, renderHook } from "@testing-library/react";

import { isInteractiveTarget, useSpaceToPlay } from "@/hooks/use-space-to-play";

function press(target: Element | Document | Window, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key: " ", code: "Space", ...init });
}

describe("useSpaceToPlay", () => {
  it("toggles playback when Space is pressed outside controls", () => {
    const toggle = vi.fn();
    renderHook(() => useSpaceToPlay(toggle));

    const notPrevented = press(document.body);

    expect(toggle).toHaveBeenCalledOnce();
    expect(notPrevented).toBe(false); // the page does not scroll
  });

  it("leaves Space to buttons, fields and sliders", () => {
    const toggle = vi.fn();
    renderHook(() => useSpaceToPlay(toggle));
    document.body.innerHTML = `
      <button>Play</button><input /><div role="slider" tabindex="0"></div>
      <div contenteditable="true"><span id="inner">text</span></div>`;

    for (const el of document.body.querySelectorAll("button, input, [role=slider], #inner")) {
      press(el);
    }

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
