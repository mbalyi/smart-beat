import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";

import { PanControl } from "@/components/pan-control";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(props: Partial<Parameters<typeof PanControl>[0]> = {}) {
  const onValueChange = vi.fn();
  const onValueCommit = vi.fn();
  function Harness() {
    const [value, setValue] = useState(props.value ?? 0);
    return (
      <PanControl
        label="Pan, Bass"
        {...props}
        value={value}
        onValueChange={(v) => {
          onValueChange(v);
          setValue(v);
        }}
        onValueCommit={onValueCommit}
      />
    );
  }
  const utils = renderWithProviders(<Harness />);
  const slider = screen.getByRole("slider", { name: props.label ?? "Pan, Bass" });
  return { ...utils, slider, onValueChange, onValueCommit };
}

/** jsdom has no layout: give the slider a width so a pointer maps to a value. */
function withWidth(slider: HTMLElement, width = 100) {
  const track = slider.closest<HTMLElement>("[data-slot=slider]")!;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 20));
  Object.assign(track, { setPointerCapture: () => {}, hasPointerCapture: () => true });
  return track;
}

describe("PanControl", () => {
  it("names the slider and speaks the L/C/R value", async () => {
    setup({ value: -0.8 });
    expect(screen.getByRole("slider", { name: "Pan, Bass" })).toHaveAttribute(
      "aria-valuetext",
      "Left 80%",
    );
    await expectNoA11yViolations();
  });

  it("shows the L/C/R value bubble on hover and hides it again", async () => {
    const { user, slider } = setup({ value: 0.7 });
    expect(screen.queryByTestId("pan-value")).toBeNull();

    await user.hover(slider);
    expect(screen.getByTestId("pan-value")).toHaveTextContent("R 70%");

    await user.unhover(slider);
    expect(screen.queryByTestId("pan-value")).toBeNull();
  });

  it("shows the value bubble on keyboard focus", async () => {
    const { user, slider } = setup({ value: -0.4 });
    await user.tab();
    expect(slider).toHaveFocus();
    expect(screen.getByTestId("pan-value")).toHaveTextContent("L 40%");
  });

  it("steps with the arrow keys, staying off the middle", async () => {
    const { user, slider, onValueChange } = setup({ value: 0 });
    await user.tab();
    expect(slider).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(onValueChange).toHaveBeenLastCalledWith(0.01);
    await user.keyboard("{ArrowRight}");
    expect(onValueChange).toHaveBeenLastCalledWith(0.02);
  });

  it("snaps a drag that lands close to the middle onto the centre", () => {
    const { slider, onValueChange } = setup({ value: 0.5 });
    const track = withWidth(slider);

    // 51 of 100 px is 2% right: inside the 5% snap, so it lands exactly on 0.
    fireEvent.pointerDown(track, { button: 0, clientX: 51, pointerId: 1 });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
  });

  it("keeps a drag that stops away from the middle", () => {
    const { slider, onValueChange } = setup({ value: 0 });
    const track = withWidth(slider);

    fireEvent.pointerDown(track, { button: 0, clientX: 70, pointerId: 1 });
    expect(onValueChange).toHaveBeenLastCalledWith(0.4);
  });

  it("recentres on double-click and reports it as finished", () => {
    const { slider, onValueChange, onValueCommit } = setup({ value: -0.5 });

    fireEvent.doubleClick(slider);
    expect(onValueChange).toHaveBeenLastCalledWith(0);
    expect(onValueCommit).toHaveBeenLastCalledWith(0);
  });

  it("does nothing on double-click when already centred", () => {
    const { slider, onValueChange, onValueCommit } = setup({ value: 0 });

    fireEvent.doubleClick(slider);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onValueCommit).not.toHaveBeenCalled();
  });

  it("does not recentre a disabled slider", () => {
    const { slider, onValueChange, onValueCommit } = setup({ value: -0.5, disabled: true });

    fireEvent.doubleClick(slider);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onValueCommit).not.toHaveBeenCalled();
  });

  it("recentres on a double-click away from the thumb", () => {
    const { slider, onValueChange, onValueCommit } = setup({ value: 0.5 });
    const track = withWidth(slider);

    // The first click of the double-click jumps the thumb and commits that
    // value; the second lands on the same value and commits nothing.
    fireEvent.pointerDown(track, { button: 0, clientX: 30, pointerId: 1, detail: 1 });
    fireEvent.pointerUp(track, { pointerId: 1, detail: 1 });
    fireEvent.pointerDown(track, { button: 0, clientX: 30, pointerId: 2, detail: 2 });
    fireEvent.pointerUp(track, { pointerId: 2, detail: 2 });
    fireEvent.doubleClick(slider, { detail: 2 });

    expect(onValueChange.mock.calls.map(([v]) => v)).toEqual([-0.4, 0]);
    expect(onValueCommit.mock.calls.map(([v]) => v)).toEqual([-0.4, 0]);
  });

  it("is a knob in the drum mixer, speaking and recentring the same way", async () => {
    const { slider, onValueChange } = setup({ label: "Pan, Kick", variant: "knob", value: -0.4 });
    expect(slider).toHaveAttribute("aria-valuetext", "Left 40%");

    fireEvent.doubleClick(slider);
    expect(onValueChange).toHaveBeenLastCalledWith(0);
    await expectNoA11yViolations();
  });

  it("shows no label of its own for the knob by default", () => {
    setup({ label: "Pan, Kick", variant: "knob", value: -0.4 });

    expect(screen.queryByText("Kick")).toBeNull();
    expect(screen.queryByText("Left 40%")).toBeNull();
  });
});
