import { fireEvent, screen } from "@testing-library/react";

import { AutomationLane } from "@/components/audio/automation-lane";
import { EMPTY_AUTOMATION } from "@/lib/score/mixer";
import type { AutomationLaneKind, TrackAutomation } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(kind: AutomationLaneKind, automation: TrackAutomation) {
  const onChange = vi.fn();
  const utils = renderWithProviders(
    <AutomationLane
      name="Bass"
      kind={kind}
      automation={automation}
      barCount={8}
      barWidth={20}
      onChange={onChange}
    />,
  );
  const lane = screen.getByRole("group", { name: new RegExp(`automation, Bass`) });
  // jsdom has no layout: the lane starts at 0,0.
  lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 44 }) as DOMRect;
  return { ...utils, lane, onChange };
}

describe("AutomationLane", () => {
  it("adds a point where it is clicked, snapped to quarter bars", () => {
    const { lane, onChange } = setup("volume", { ...EMPTY_AUTOMATION, enabled: true });
    const background = lane.querySelector("rect")!;
    fireEvent.pointerDown(background, { button: 0, clientX: 51, clientY: 5 });
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      volume: [{ bar: 2.5, value: 1 }],
      pan: [],
      mute: [],
    });
  });

  it("drags points and moves them with the keyboard", async () => {
    const automation = { ...EMPTY_AUTOMATION, enabled: true, pan: [{ bar: 2, value: 0 }] };
    const { user, lane, onChange } = setup("pan", automation);
    const point = screen.getByRole("slider", { name: "Pan point at bar 3" });
    expect(point).toHaveAttribute("aria-valuetext", "Centre");
    fireEvent.pointerDown(point, { pointerId: 1 });
    fireEvent.pointerMove(point, { pointerId: 1, clientX: 100, clientY: 39 });
    fireEvent.pointerUp(point, { pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pan: [{ bar: 5, value: -1 }] }),
    );
    point.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pan: [{ bar: 2.25, value: 0 }] }),
    );
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pan: [{ bar: 2, value: -0.1 }] }),
    );
    void lane;
    await expectNoA11yViolations();
  });

  it("makes mute points on or off, and Delete removes them", async () => {
    const automation = { ...EMPTY_AUTOMATION, enabled: true, mute: [{ bar: 1, value: 0 }] };
    const { user, lane, onChange } = setup("mute", automation);
    fireEvent.pointerDown(lane.querySelector("rect")!, { button: 0, clientX: 80, clientY: 20 });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mute: [
          { bar: 1, value: 0 },
          { bar: 4, value: 1 },
        ],
      }),
    );
    const point = screen.getByRole("slider", { name: "Mute point at bar 2" });
    expect(point).toHaveAttribute("aria-valuetext", "On");
    point.focus();
    await user.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mute: [{ bar: 1, value: 1 }] }),
    );
    await user.keyboard("{Delete}");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mute: [] }));
  });
});
