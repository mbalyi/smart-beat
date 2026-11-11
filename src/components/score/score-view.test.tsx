import { render, screen, within } from "@testing-library/react";

import { ScoreView, type EditOverlay, type RemoteMark } from "@/components/score/score-view";

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

  describe("another player's cursor (#216)", () => {
    const note = { x: 100, y: 80, w: 12, h: 14 };
    const px = (value: string) => parseFloat(value);
    const marks = (remote: RemoteMark[]) =>
      renderView({ editing: true, overlay: { notes: [], selection: [], remote } });

    it("marks only the note they have selected, like our own cursor", () => {
      marks([
        {
          id: "ann",
          name: "Ann",
          hue: 200,
          notes: [
            { rect: note, staff: "tab" },
            { rect: { x: 100, y: 10, w: 11, h: 9 }, staff: "score" },
          ],
          selection: [],
        },
      ]);

      const cursor = screen.getByTestId("remote-cursor");
      expect(cursor).toHaveAttribute("data-player", "Ann");
      // One outline on the tab, the size of our own cursor's (the note and 2 px around it) ...
      const outline = within(cursor).getByTestId("remote-note");
      expect(outline.style).toMatchObject({
        left: "98px",
        top: "79px",
        width: "16px",
        height: "16px",
      });
      // ... a thin ring on the notehead of the standard staff, and no range at all.
      const head = within(cursor).getByTestId("remote-head");
      expect(head.style).toMatchObject({ left: "99px", top: "9px", width: "13px", height: "11px" });
      expect(within(cursor).queryByTestId("remote-selection")).toBeNull();
      // The name sits right above the outline, on a dark pill with white text.
      const name = within(cursor).getByTestId("remote-name");
      expect(name).toHaveTextContent("Ann");
      expect(px(name.style.left)).toBe(98);
      expect(px(name.style.top)).toBe(79);
      expect(name).toHaveClass("-translate-y-full", "text-white");
    });

    it("draws a lighter range only when there is one, with the name at its start", () => {
      marks([
        {
          id: "ann",
          name: "Ann",
          hue: 200,
          notes: [{ rect: note, staff: "tab" }],
          selection: [
            { x: 100, y: 40, w: 300, h: 120 },
            { x: 20, y: 240, w: 180, h: 120 },
          ],
        },
      ]);

      const cursor = screen.getByTestId("remote-cursor");
      const rows = within(cursor).getAllByTestId("remote-selection");
      expect(rows.map((row) => row.style.width)).toEqual(["300px", "180px"]);
      expect(rows[0]!.style.backgroundColor).toContain("0.09");
      expect(within(cursor).getAllByTestId("remote-note")).toHaveLength(1);
      // The name tag is at the start of the range, not at the note.
      const name = within(cursor).getByTestId("remote-name");
      expect(px(name.style.left)).toBe(100);
      expect(px(name.style.top)).toBe(40);
    });

    it("keeps one cursor per player, each in their own colour", () => {
      marks([
        { id: "ann", name: "Ann", hue: 200, notes: [{ rect: note, staff: "tab" }], selection: [] },
        { id: "bob", name: "Bob", hue: 20, notes: [{ rect: note, staff: "tab" }], selection: [] },
      ]);

      const names = screen.getAllByTestId("remote-name");
      expect(names.map((n) => n.textContent)).toEqual(["Ann", "Bob"]);
      expect(names[0]!.style.backgroundColor).not.toBe(names[1]!.style.backgroundColor);
    });
  });

  describe("keeping the edit cursor in view (#228)", () => {
    /** The region shows content 1000…1600 × 200…600 of its scrolled content. */
    function scrolledRegion() {
      const el = region();
      const scroll = { left: 1000, top: 200 };
      Object.defineProperties(el, {
        scrollLeft: { configurable: true, get: () => scroll.left },
        scrollTop: { configurable: true, get: () => scroll.top },
        clientWidth: { configurable: true, value: 600 },
        clientHeight: { configurable: true, value: 400 },
      });
      const scrollTo = vi.fn((to: { left: number; top: number }) => Object.assign(scroll, to));
      el.scrollTo = scrollTo as never;
      // The region sits at the window's origin; the marks are placed by their style in the
      // scrolled content.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this === el) return new DOMRect(0, 0, 600, 400);
        const { left, top, width, height } = this.style;
        return new DOMRect(
          parseFloat(left) - scroll.left,
          parseFloat(top) - scroll.top,
          parseFloat(width),
          parseFloat(height),
        );
      });
      return scrollTo;
    }

    const at = (x: number, y = 300): EditOverlay => ({
      notes: [{ rect: { x, y, w: 10, h: 12 }, staff: "tab" }],
      selection: [],
    });

    const view = (overlay: EditOverlay | null) => (
      <ScoreView
        viewportRef={{ current: null }}
        surfaceRef={{ current: null }}
        label="Score: Guitar"
        layout="horizontal"
        rendering={false}
        editing
        overlay={overlay}
      />
    );

    afterEach(() => vi.restoreAllMocks());

    it("does not scroll while the cursor is in view, also when the score is drawn again", () => {
      const { rerender } = render(view(null));
      const scrollTo = scrolledRegion();

      rerender(view(at(1300)));
      // An edit draws the score again: new marks at the same place.
      rerender(view(at(1300)));
      // The cursor moved, but stays in view.
      rerender(view(at(1290)));
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("scrolls only as far as needed when the cursor would leave the view", () => {
      const { rerender } = render(view(null));
      const scrollTo = scrolledRegion();

      // Past the right edge: the outline (2 px around the note, so 1593…1607) comes just inside.
      rerender(view(at(1595)));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 1007, top: 200, behavior: "instant" });

      // Before the left edge: no jump to the start of the bar or the score.
      rerender(view(at(900)));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 898, top: 200, behavior: "instant" });
    });
  });
});
