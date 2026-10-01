import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";

import { Knob } from "@/components/ui/knob";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(props: Partial<Parameters<typeof Knob>[0]> = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  function Harness() {
    const [value, setValue] = useState(props.value ?? 0);
    return (
      <Knob
        label="Drive, Gain"
        valueText={`${value}`}
        min={-10}
        max={10}
        step={1}
        {...props}
        value={value}
        onValueChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        onValueCommit={onCommit}
      />
    );
  }
  const utils = renderWithProviders(<Harness />);
  return {
    ...utils,
    knob: screen.getByRole("slider", { name: "Drive, Gain" }),
    onChange,
    onCommit,
  };
}

describe("Knob", () => {
  it("is a labelled slider with its value", async () => {
    const { knob } = setup({ value: 3 });
    expect(knob).toHaveAttribute("aria-valuenow", "3");
    expect(knob).toHaveAttribute("aria-valuetext", "3");
    expect(knob).toHaveAttribute("aria-valuemin", "-10");
    expect(screen.getByText("Gain")).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("changes with arrows, Page Up/Down, Home and End", async () => {
    const { user, knob, onChange, onCommit } = setup();
    knob.focus();
    await user.keyboard("{ArrowUp}{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(2);
    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith(1);
    await user.keyboard("{PageUp}");
    expect(onChange).toHaveBeenLastCalledWith(3);
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith(-10);
    await user.keyboard("{End}{End}");
    expect(onChange).toHaveBeenLastCalledWith(10);
    expect(onCommit).toHaveBeenLastCalledWith(10);
    // At the end already: no change is reported.
    expect(onChange).toHaveBeenCalledTimes(6);
  });

  it("follows vertical drags and resets on double-click", () => {
    const { knob, onChange, onCommit } = setup({ value: 0 });
    fireEvent.pointerDown(knob, { button: 0, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(knob, { clientY: 120, pointerId: 1 });
    // 80 px of a 160 px drag range: half of the 20-wide range.
    expect(onChange).toHaveBeenLastCalledWith(10);
    fireEvent.pointerMove(knob, { clientY: 224, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(-3);
    fireEvent.pointerUp(knob, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(-3);
    fireEvent.doubleClick(knob);
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("does nothing when disabled", async () => {
    const { user, knob, onChange } = setup({ disabled: true });
    expect(knob).toHaveAttribute("aria-disabled", "true");
    knob.focus();
    await user.keyboard("{ArrowUp}");
    fireEvent.doubleClick(knob);
    expect(onChange).not.toHaveBeenCalled();
  });
});
