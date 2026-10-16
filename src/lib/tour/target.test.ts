import { findTourTarget, isShown } from "@/lib/tour/target";

/** jsdom does no layout: give every element a box so `isShown` can tell inert from shown. */
function withLayout(run: () => void) {
  const original = Element.prototype.getClientRects;
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  try {
    run();
  } finally {
    Element.prototype.getClientRects = original;
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findTourTarget", () => {
  it("is null when nothing has the name", () => {
    withLayout(() => expect(findTourTarget("play")).toBeNull());
  });

  it("skips the controls of a song that is not shown (inert) and finds the shown song's", () => {
    document.body.innerHTML = `
      <div inert><button id="first" data-tour="play"></button></div>
      <div><button id="second" data-tour="play"></button></div>`;
    withLayout(() => expect(findTourTarget("play")?.id).toBe("second"));
  });

  it("skips hidden and invisible controls", () => {
    document.body.innerHTML = `
      <div hidden><button id="a" data-tour="play"></button></div>
      <div style="visibility: hidden"><button id="b" data-tour="play"></button></div>
      <button id="c" data-tour="play"></button>`;
    withLayout(() => expect(findTourTarget("play")?.id).toBe("c"));
  });

  it("is null when every match is out of sight", () => {
    document.body.innerHTML = `<div inert><button data-tour="play"></button></div>`;
    withLayout(() => expect(findTourTarget("play")).toBeNull());
  });

  it("treats an element without a box as not shown", () => {
    document.body.innerHTML = `<button id="x" data-tour="play"></button>`;
    // jsdom gives no boxes at all.
    expect(isShown(document.getElementById("x")!)).toBe(false);
  });
});
