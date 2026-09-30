import { fireEvent, screen, within } from "@testing-library/react";

import { BendDialog, type CurveKind } from "@/components/score/bend-dialog";
import { BEND_PRESETS, type CurvePoint } from "@/lib/score/effects";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(kind: CurveKind = "bend", initial: CurvePoint[] | null = null) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <BendDialog
      open
      onOpenChange={onOpenChange}
      kind={kind}
      initial={initial}
      onSubmit={onSubmit}
    />,
  );
  return { ...utils, onSubmit, onOpenChange };
}

const points = () =>
  within(screen.getByRole("list", { name: "Points" }))
    .getAllByRole("listitem")
    .map((item) => [
      Number(within(item).getByRole("spinbutton").getAttribute("value")),
      within(item).getByRole("combobox").textContent,
    ]);

describe("BendDialog", () => {
  it("starts a new bend as a full-step bend and applies it", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    expect(screen.getByRole("dialog", { name: "Bend" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Bend" })).toBeChecked();
    expect(screen.getByRole("img", { name: "Curve: full step up" })).toBeInTheDocument();
    expect(points()).toEqual([
      [0, "Not bent"],
      [15, "+full step"],
      [60, "+full step"],
    ]);
    await expectNoA11yViolations();

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith(BEND_PRESETS[0]!.points(4));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("button", { name: "Remove bend" })).not.toBeInTheDocument();
  });

  it("changes the shape and height", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByRole("radio", { name: "Bend and release" }));
    await user.click(screen.getByRole("combobox", { name: "Bend by" }));
    await user.click(await screen.findByRole("option", { name: "½ step" }));
    expect(screen.getByRole("img", { name: "Curve: ½ step up and back" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith(BEND_PRESETS[1]!.points(2));
  });

  it("edits points with the keyboard", async () => {
    const { user, onSubmit } = setup();
    const position = screen.getByRole("spinbutton", { name: "Point 2 position" });
    await user.clear(position);
    await user.type(position, "30");
    await user.click(screen.getByRole("combobox", { name: "Point 3 pitch" }));
    await user.click(await screen.findByRole("option", { name: "+2 steps" }));
    expect(screen.getByRole("radio", { name: "Bend" })).not.toBeChecked(); // now custom
    await user.click(screen.getByRole("button", { name: "Remove point 2" }));
    // The last point is at the end of the note: nothing can come after it.
    expect(screen.getByRole("button", { name: "Add point" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith([
      { offset: 0, value: 0 },
      { offset: 60, value: 8 },
    ]);
  });

  it("keeps at least two points, and adds points after the last one", async () => {
    const { user } = setup("bend", [
      { offset: 0, value: 4 },
      { offset: 40, value: 4 },
    ]);
    expect(screen.getByRole("button", { name: "Remove point 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove point 2" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add point" }));
    expect(points()).toEqual([
      [0, "+full step"],
      [40, "+full step"],
      [45, "+full step"],
    ]);
  });

  it("removes an existing bend", async () => {
    const { user, onSubmit } = setup("bend", [
      { offset: 0, value: 0 },
      { offset: 60, value: 4 },
    ]);
    expect(screen.getByRole("radio", { name: "Bend" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Remove bend" }));
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it("edits whammy bar dives below the note", async () => {
    const { user, onSubmit } = setup("whammy");
    expect(screen.getByRole("dialog", { name: "Whammy bar" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Curve: 2 steps down" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Dip" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith([
      { offset: 0, value: 0 },
      { offset: 15, value: -8 },
      { offset: 30, value: 0 },
    ]);
    await expectNoA11yViolations();
  });

  it("adds and drags points on the graph", async () => {
    const { user, onSubmit } = setup();
    const graph = screen.getByRole("img", { name: /^Curve/ }) as unknown as SVGSVGElement;
    // jsdom has no layout: map screen pixels 1:1 to the graph's units.
    const identity = { inverse: () => identity } as unknown as DOMMatrix;
    graph.getScreenCTM = () => identity;
    vi.stubGlobal(
      "DOMPoint",
      class {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        matrixTransform() {
          return this;
        }
      },
    );
    // Click at offset 30 (x = 16 + 30/60 × 288), pitch 6 (y = 16 + (1 − 6/12) × 128).
    fireEvent.pointerDown(graph, { clientX: 160, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(graph, { pointerId: 1 });
    expect(points()).toHaveLength(4);
    expect(points()[2]).toEqual([30, "+1½ steps"]);

    // Drag the last point down to the note's pitch.
    const handle = graph.querySelectorAll("[data-point]")[3]!;
    fireEvent.pointerDown(handle, { clientX: 304, clientY: 80, pointerId: 1 });
    fireEvent.pointerMove(graph, { clientX: 304, clientY: 144, pointerId: 1 });
    fireEvent.pointerUp(graph, { pointerId: 1 });
    expect(points()[3]).toEqual([60, "Not bent"]);

    // Double-click removes a point.
    fireEvent.doubleClick(graph.querySelectorAll("[data-point]")[2]!);
    expect(points()).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith([
      { offset: 0, value: 0 },
      { offset: 15, value: 4 },
      { offset: 60, value: 0 },
    ]);
  });
});
