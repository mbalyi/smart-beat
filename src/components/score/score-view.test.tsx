import { render, screen } from "@testing-library/react";

import { ScoreView, type EditOverlay } from "@/components/score/score-view";

function renderView(props: { editing?: boolean; playing?: boolean; overlay?: EditOverlay }) {
  return render(
    <ScoreView
      viewportRef={{ current: null }}
      surfaceRef={{ current: null }}
      label="Score: Guitar"
      layout="page"
      rendering={false}
      {...props}
    />,
  );
}

const region = () => screen.getByRole("region", { name: "Score: Guitar" });

describe("ScoreView", () => {
  it("marks editing and playing on the scroll region (they decide alphaTab's cursor, see index.css)", () => {
    const { rerender } = renderView({});
    expect(region()).not.toHaveAttribute("data-editing");
    expect(region()).not.toHaveAttribute("data-playing");

    rerender(
      <ScoreView
        viewportRef={{ current: null }}
        surfaceRef={{ current: null }}
        label="Score: Guitar"
        layout="page"
        rendering={false}
        editing
      />,
    );
    expect(region()).toHaveAttribute("data-editing");
    expect(region()).not.toHaveAttribute("data-playing");

    rerender(
      <ScoreView
        viewportRef={{ current: null }}
        surfaceRef={{ current: null }}
        label="Score: Guitar"
        layout="page"
        rendering={false}
        editing
        playing
      />,
    );
    expect(region()).toHaveAttribute("data-playing");
  });

  it("outlines the fret number and rings the notehead of a note", () => {
    renderView({
      editing: true,
      overlay: {
        notes: [
          { rect: { x: 20, y: 100, w: 8, h: 10 }, staff: "tab" },
          { rect: { x: 20, y: 40, w: 9, h: 7 }, staff: "score" },
        ],
        selection: [],
      },
    });
    expect(screen.getAllByTestId("edit-cursor-note")).toHaveLength(1);
    expect(screen.getByTestId("edit-cursor-note")).toHaveClass("rounded-md", "border-brand");
    expect(screen.getAllByTestId("edit-cursor-head")).toHaveLength(1);
    expect(screen.getByTestId("edit-cursor-head")).toHaveClass("ring-1");
    expect(screen.queryByTestId("edit-cursor")).not.toBeInTheDocument();
  });

  it("outlines a note on a score-only staff, without a ring", () => {
    renderView({
      editing: true,
      overlay: { notes: [{ rect: { x: 20, y: 40, w: 9, h: 7 }, staff: "score" }], selection: [] },
    });
    expect(screen.getAllByTestId("edit-cursor-note")).toHaveLength(1);
    expect(screen.queryByTestId("edit-cursor-head")).not.toBeInTheDocument();
  });

  it("draws a range as light translucent rectangles", () => {
    renderView({
      editing: true,
      overlay: {
        notes: [],
        selection: [
          { x: 10, y: 20, w: 300, h: 80 },
          { x: 10, y: 200, w: 120, h: 80 },
        ],
      },
    });
    const ranges = screen.getAllByTestId("edit-selection");
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toHaveClass("bg-brand/15", "border-brand/40", "rounded-sm");
    expect(ranges[1]).toHaveStyle({ left: "10px", top: "200px", width: "120px" });
  });
});
