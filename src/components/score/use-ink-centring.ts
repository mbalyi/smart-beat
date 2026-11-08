import { useLayoutEffect, type RefObject } from "react";

let measuring: CanvasRenderingContext2D | null | undefined;
const canvasContext = () => {
  if (measuring === undefined) {
    // jsdom has no canvas: nothing to measure there, the text keeps its place.
    measuring =
      typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)
        ? null
        : document.createElement("canvas").getContext("2d");
  }
  return measuring;
};

/**
 * Moves written text so that the middle of its ink (what is really drawn: capitals, a descender
 * like the g of "rasg.", the dots) is on the middle of its button. The text box centres the box,
 * not the letters, so marks with and without descenders would sit on different lines. The shift is
 * measured in the browser from the real font and set in em, so it follows zoom.
 */
export function useInkCentring(ref: RefObject<HTMLElement | null>, text: string, enabled = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    const ctx = canvasContext();
    if (!enabled || !element || !ctx) return;

    const centre = () => {
      const cell = element.closest("button")?.getBoundingClientRect();
      if (!cell) return;
      element.style.translate = "";
      const style = getComputedStyle(element);
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const ink = ctx.measureText(text);
      // A zero-size inline box sits on the baseline of the text.
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      element.appendChild(probe);
      const baseline = probe.getBoundingClientRect().bottom;
      element.removeChild(probe);
      const middle = baseline + (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2;
      const shift = (cell.top + cell.bottom) / 2 - middle;
      const size = parseFloat(style.fontSize);
      if (Number.isFinite(shift) && size > 0) element.style.translate = `0 ${shift / size}em`;
    };

    centre();
    // A web font that arrives later changes the metrics.
    void document.fonts?.ready.then(centre);
  }, [ref, text, enabled]);
}
