/**
 * Printing the score, and saving it as a PDF (the system's print dialog does
 * that: "Save as PDF"). alphaTab draws the score as SVG in the window; for the
 * printer a copy of it is put in `#print-root`, which is the only thing shown
 * when printing (see index.css), scaled to the width of the page.
 */

export type Paper = "a4" | "letter" | "a3";
export type Orientation = "portrait" | "landscape";

export interface PrintSettings {
  paper: Paper;
  orientation: Orientation;
  /** Page margin in millimetres. */
  margin: number;
  /** Size of the notation on paper (1 = 100%). */
  scale: number;
}

/** Which tracks a print shows: indexes into the score's tracks. Not remembered (songs differ). */
export type PrintTracks = number[];

/** Notation sizes offered for printing. */
export const PRINT_SCALES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

export const PAPERS: { value: Paper; label: string; css: string }[] = [
  { value: "a4", label: "A4", css: "A4" },
  { value: "letter", label: "Letter", css: "letter" },
  { value: "a3", label: "A3", css: "A3" },
];

export const MARGINS = [5, 10, 15, 20, 25] as const;

export const DEFAULT_PRINT: PrintSettings = {
  paper: "a4",
  orientation: "portrait",
  margin: 15,
  scale: 0.9,
};

export const PRINT_STORAGE_KEY = "smart-beat:print";

/** The `@page` rule for the settings: paper size, orientation and margin. */
export function pageCss({ paper, orientation, margin }: PrintSettings): string {
  const size = PAPERS.find((p) => p.value === paper)?.css ?? "A4";
  return `@page { size: ${size} ${orientation}; margin: ${margin}mm; }`;
}

/** Paper sizes in points (1/72 inch), portrait. */
const PAPER_POINTS: Record<Paper, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  a3: [841.89, 1190.55],
};

/** The page of a PDF export (#83), for `writePdfFile`. Mirrors `PdfPage` in `src-tauri/src/pdf.rs`. */
export interface PdfPage {
  widthPt: number;
  heightPt: number;
  marginPt: number;
  landscape: boolean;
}

export function pdfPage({ paper, orientation, margin }: PrintSettings): PdfPage {
  const [widthPt, heightPt] = PAPER_POINTS[paper];
  return {
    widthPt,
    heightPt,
    marginPt: Math.round(((margin * 72) / 25.4) * 100) / 100,
    landscape: orientation === "landscape",
  };
}

export function readPrintSettings(): PrintSettings {
  try {
    const raw = localStorage.getItem(PRINT_STORAGE_KEY);
    if (!raw) return DEFAULT_PRINT;
    const value = JSON.parse(raw) as Partial<PrintSettings> | null;
    return {
      paper: PAPERS.some((p) => p.value === value?.paper) ? value!.paper! : DEFAULT_PRINT.paper,
      orientation:
        value?.orientation === "landscape" || value?.orientation === "portrait"
          ? value.orientation
          : DEFAULT_PRINT.orientation,
      margin: MARGINS.some((m) => m === value?.margin) ? value!.margin! : DEFAULT_PRINT.margin,
      scale: PRINT_SCALES.some((s) => s === value?.scale) ? value!.scale! : DEFAULT_PRINT.scale,
    };
  } catch {
    return DEFAULT_PRINT;
  }
}

export function storePrintSettings(settings: PrintSettings) {
  try {
    localStorage.setItem(PRINT_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not remembered: the defaults apply next time.
  }
}

/** Lets an SVG scale to the page: a view box from its size, and the full width. */
function makeResponsive(svg: SVGElement) {
  const width = Number.parseFloat(svg.getAttribute("width") ?? "");
  const height = Number.parseFloat(svg.getAttribute("height") ?? "");
  if (!svg.getAttribute("viewBox") && width > 0 && height > 0) {
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.width = "100%";
  svg.style.height = "auto";
  svg.style.display = "block";
}

/**
 * A copy of what alphaTab drew in `surface`, ready to print. Null when nothing
 * is drawn yet.
 */
export function buildPrintRoot(surface: HTMLElement): HTMLElement | null {
  const svgs = surface.querySelectorAll("svg");
  if (svgs.length === 0) return null;
  const root = document.createElement("div");
  root.id = "print-root";
  for (const part of Array.from(surface.children)) {
    if (!part.querySelector("svg") && part.tagName.toLowerCase() !== "svg") continue;
    const copy = part.cloneNode(true) as HTMLElement;
    copy.removeAttribute("style"); // alphaTab positions and sizes its parts in pixels
    for (const svg of copy.tagName.toLowerCase() === "svg"
      ? [copy]
      : copy.querySelectorAll("svg")) {
      makeResponsive(svg as unknown as SVGElement);
    }
    root.append(copy);
  }
  return root;
}

/**
 * Resolves when the score is drawn in `surface`: alphaTab adds its SVG parts a
 * moment after a render finishes, so this waits until there are some and no
 * more come. False if nothing appears within `timeoutMs`.
 */
export function whenDrawn(surface: HTMLElement, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    let last = -1;
    const check = () => {
      const count = surface.querySelectorAll("svg").length;
      if (count > 0 && count === last) {
        resolve(true);
        return;
      }
      last = count;
      if (Date.now() - started > timeoutMs) resolve(count > 0);
      else setTimeout(check, 100);
    };
    check();
  });
}

/**
 * Opens the system print dialog for the score in `surface`. Returns a function
 * that removes the print copy (also done after printing); null if there is
 * nothing to print. In the macOS app `window.print()` is a call to the app that
 * can fail later: then the copy is removed and `onFailed` says why.
 */
export function printScore(
  surface: HTMLElement,
  settings: PrintSettings,
  print: () => unknown = () => window.print(),
  onFailed?: (error: unknown) => void,
): (() => void) | null {
  const root = buildPrintRoot(surface);
  if (!root) return null;
  const style = document.createElement("style");
  style.id = "print-page-style";
  style.textContent = pageCss(settings);
  document.head.append(style);
  document.body.append(root);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener("afterprint", cleanup);
    root.remove();
    style.remove();
  };
  window.addEventListener("afterprint", cleanup);
  let result: unknown;
  try {
    result = print();
  } catch (error) {
    cleanup();
    throw error;
  }
  // Tauri's print on macOS returns a promise; no "afterprint" comes when it fails.
  if (result instanceof Promise) {
    result.catch((error: unknown) => {
      cleanup();
      onFailed?.(error);
    });
  }
  return cleanup;
}
