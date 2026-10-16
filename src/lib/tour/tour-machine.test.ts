import { startRun, transition, type TourRun } from "@/lib/tour/tour-machine";

const run = (index: number, direction: 1 | -1 = 1): TourRun => ({ tour: "main", index, direction });

describe("startRun", () => {
  it("starts at the first step going forward", () => {
    expect(startRun("main")).toEqual({ tour: "main", index: 0, direction: 1 });
  });
  it("can start at a given step", () => {
    expect(startRun("editing", 2)).toEqual({ tour: "editing", index: 2, direction: 1 });
  });
});

describe("transition", () => {
  it("next moves forward", () => {
    expect(transition(run(0), "next", 3)).toEqual({ run: run(1) });
    expect(transition(run(1, -1), "next", 3)).toEqual({ run: run(2, 1) });
  });

  it("next at the last step ends the tour as done", () => {
    expect(transition(run(2), "next", 3)).toEqual({ run: null, ended: "done" });
  });

  it("skip and close end the tour", () => {
    expect(transition(run(1), "skip", 3)).toEqual({ run: null, ended: "skipped" });
    expect(transition(run(1), "close", 3)).toEqual({ run: null, ended: "interrupted" });
  });

  it("back moves back and stays at 0", () => {
    expect(transition(run(2), "back", 3)).toEqual({ run: run(1, -1) });
    expect(transition(run(0), "back", 3)).toEqual({ run: run(0, -1) });
  });

  it("missing skips forward when going forward", () => {
    expect(transition(run(0), "missing", 3)).toEqual({ run: run(1) });
    expect(transition(run(2), "missing", 3)).toEqual({ run: null, ended: "done" });
  });

  it("missing skips backward when going backward", () => {
    expect(transition(run(2, -1), "missing", 3)).toEqual({ run: run(1, -1) });
  });

  it("missing going backward past 0 goes forward from the start", () => {
    expect(transition(run(0, -1), "missing", 3)).toEqual({ run: run(1, 1) });
    expect(transition(run(0, -1), "missing", 1)).toEqual({ run: null, ended: "done" });
  });

  it("does not mutate the run", () => {
    const r = run(1);
    transition(r, "next", 3);
    expect(r).toEqual(run(1));
  });
});
