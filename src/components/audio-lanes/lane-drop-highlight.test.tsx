import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LaneDropHighlight } from "@/components/audio-lanes/lane-drop-highlight";
import { dropLabel } from "@/lib/audio-lanes/drop-target";
import { FileDragStore } from "@/lib/file-drag-store";

/** A lane element 200 px from the left, 100 px from the top, 1000 px wide, 1 px = 10 ms. */
function mockLane() {
  const lane = document.createElement("div");
  lane.dataset.laneId = "lane-a";
  lane.dataset.msPerPx = "10";
  lane.getBoundingClientRect = () =>
    ({ left: 200, top: 100, width: 1000, height: 52, right: 1200, bottom: 152 }) as DOMRect;
  document.body.append(lane);
  document.elementFromPoint = vi.fn(() => lane);
  return lane;
}

function setup(count = 1, snap: (ms: number) => number = (ms) => ms) {
  const store = new FileDragStore();
  render(
    <LaneDropHighlight
      store={store}
      count={count}
      msAtBar={(bar) => bar * 2000}
      snapTo={snap}
      laneName={(id) => (id === "lane-a" ? "Bass" : "")}
    />,
  );
  return store;
}

describe("LaneDropHighlight", () => {
  let lane: HTMLElement;
  beforeEach(() => {
    lane = mockLane();
  });
  afterEach(() => {
    lane.remove();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("words the label with the lane, the time and the number of files", () => {
    expect(dropLabel("Bass", 42_900)).toBe("Drop to add to Bass · 0:42");
    expect(dropLabel("Bass", 65_000, 3)).toBe("Drop to add 3 files to Bass · 1:05");
    expect(dropLabel("Bass", 0, 1)).toBe("Drop to add to Bass · 0:00");
  });

  it("shows nothing until files are over a lane", () => {
    const store = setup();
    expect(screen.queryByTestId("lane-drop-highlight")).toBeNull();
    act(() => store.set({ x: 300, y: 120 }));
    expect(screen.getByTestId("lane-drop-highlight")).toBeInTheDocument();
    act(() => store.set(null));
    expect(screen.queryByTestId("lane-drop-highlight")).toBeNull();
  });

  it("outlines the lane, draws the drop line at the pointer and names the snapped time", () => {
    const store = setup(1, (ms) => Math.round(ms / 500) * 500);
    // 300 px is 100 px into the lane: 1000 ms.
    act(() => store.set({ x: 300, y: 120 }));
    const box = screen.getByTestId("lane-drop-highlight");
    expect(box).toHaveAttribute("data-drop-target", "lane-a");
    expect(box).toHaveStyle({ left: "200px", top: "100px", width: "1000px", height: "52px" });
    expect(box).toHaveClass("pointer-events-none", "outline-primary");
    expect(screen.getByTestId("lane-drop-line")).toHaveStyle({ left: "100px" });
    expect(screen.getByTestId("lane-drop-label")).toHaveTextContent("Drop to add to Bass · 0:01");
    // The line and the time follow the pointer, and the time is the snapped one.
    act(() => store.set({ x: 1000, y: 120 }));
    expect(screen.getByTestId("lane-drop-line")).toHaveStyle({ left: "800px" });
    expect(screen.getByTestId("lane-drop-label")).toHaveTextContent("Drop to add to Bass · 0:08");
    act(() => store.set({ x: 1003, y: 120 }));
    expect(screen.getByTestId("lane-drop-label")).toHaveTextContent("Drop to add to Bass · 0:08");
  });

  it("counts several files in the label", () => {
    const store = setup(3);
    act(() => store.set({ x: 300, y: 120 }));
    expect(screen.getByTestId("lane-drop-label")).toHaveTextContent(
      "Drop to add 3 files to Bass · 0:01",
    );
  });

  it("keeps its chip above the lane when there is room and inside it at the top of the window", () => {
    const store = setup();
    act(() => store.set({ x: 300, y: 120 }));
    expect(screen.getByTestId("lane-drop-label")).toHaveClass("bottom-full");
    lane.getBoundingClientRect = () =>
      ({ left: 200, top: 4, width: 1000, height: 52, right: 1200, bottom: 56 }) as DOMRect;
    act(() => store.set({ x: 301, y: 20 }));
    expect(screen.getByTestId("lane-drop-label")).not.toHaveClass("bottom-full");
  });

  it("does not subscribe to the pointer when nothing audio is dragged", () => {
    render(
      <LaneDropHighlight
        count={0}
        msAtBar={(bar) => bar}
        snapTo={(ms) => ms}
        laneName={() => ""}
      />,
    );
    expect(screen.queryByTestId("lane-drop-highlight")).toBeNull();
  });
});
