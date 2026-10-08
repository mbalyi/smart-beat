import {
  buildPrintRoot,
  DEFAULT_PRINT,
  pageCss,
  printScore,
  PRINT_STORAGE_KEY,
  readPrintSettings,
  storePrintSettings,
  whenDrawn,
} from "@/lib/print";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Something like what alphaTab draws: parts (divs with pixel sizes) that hold an SVG each. */
function surface(parts = 2) {
  const element = document.createElement("div");
  element.className = "at-surface";
  for (let i = 0; i < parts; i++) {
    const part = document.createElement("div");
    part.style.cssText = "position:absolute;width:1000px;height:400px;top:0px";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "1000");
    svg.setAttribute("height", "400");
    part.append(svg);
    element.append(part);
  }
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.querySelectorAll("#print-page-style").forEach((e) => e.remove());
});

describe("pageCss", () => {
  it("sets paper size, orientation and margin", () => {
    expect(pageCss({ paper: "a4", orientation: "portrait", margin: 15, scale: 1 })).toBe(
      "@page { size: A4 portrait; margin: 15mm; }",
    );
    expect(pageCss({ paper: "letter", orientation: "landscape", margin: 10, scale: 1 })).toBe(
      "@page { size: letter landscape; margin: 10mm; }",
    );
    expect(pageCss({ paper: "a3", orientation: "portrait", margin: 5, scale: 1 })).toContain("A3");
  });
});

describe("print settings", () => {
  it("start with A4 portrait, 15 mm margins and notation at 90%", () => {
    expect(readPrintSettings()).toEqual(DEFAULT_PRINT);
    expect(DEFAULT_PRINT).toEqual({ paper: "a4", orientation: "portrait", margin: 15, scale: 0.9 });
  });

  it("are remembered", () => {
    const settings = {
      paper: "letter",
      orientation: "landscape",
      margin: 20,
      scale: 1.25,
    } as const;
    storePrintSettings(settings);
    expect(readPrintSettings()).toEqual(settings);
  });

  it("ignore damaged or unknown values", () => {
    localStorage.setItem(PRINT_STORAGE_KEY, "{oops");
    expect(readPrintSettings()).toEqual(DEFAULT_PRINT);
    localStorage.setItem(
      PRINT_STORAGE_KEY,
      JSON.stringify({ paper: "tabloid", orientation: "sideways", margin: 13, scale: 7 }),
    );
    expect(readPrintSettings()).toEqual(DEFAULT_PRINT);
    localStorage.setItem(PRINT_STORAGE_KEY, "null");
    expect(readPrintSettings()).toEqual(DEFAULT_PRINT);
  });
});

describe("buildPrintRoot", () => {
  it("copies every drawn part and lets the SVGs scale to the page", () => {
    const root = buildPrintRoot(surface(2))!;

    expect(root.id).toBe("print-root");
    expect(root.children).toHaveLength(2);
    for (const part of Array.from(root.children) as HTMLElement[]) {
      expect(part.getAttribute("style")).toBeNull(); // no pixel positions
      const svg = part.querySelector("svg")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 1000 400");
      expect(svg.getAttribute("width")).toBeNull();
      expect(svg.style.width).toBe("100%");
    }
  });

  it("leaves the score in the window as it is", () => {
    const original = surface(1);
    buildPrintRoot(original);
    const svg = original.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("1000");
    expect(svg.getAttribute("viewBox")).toBeNull();
  });

  it("keeps an existing view box", () => {
    const element = surface(1);
    element.querySelector("svg")!.setAttribute("viewBox", "0 0 500 200");
    expect(buildPrintRoot(element)!.querySelector("svg")!.getAttribute("viewBox")).toBe(
      "0 0 500 200",
    );
  });

  it("skips what is not drawn, and gives nothing for an empty score", () => {
    const element = surface(1);
    element.append(document.createElement("div")); // no SVG in it
    expect(buildPrintRoot(element)!.children).toHaveLength(1);
    expect(buildPrintRoot(document.createElement("div"))).toBeNull();
  });
});

describe("printScore", () => {
  it("shows the copy and the page rule while the print dialog is open, and removes them after printing", () => {
    const element = surface(1);
    const print = vi.fn(() => {
      expect(document.getElementById("print-root")).not.toBeNull();
      expect(document.getElementById("print-page-style")!.textContent).toBe(
        "@page { size: A4 portrait; margin: 15mm; }",
      );
    });

    const cleanup = printScore(element, DEFAULT_PRINT, print);

    expect(print).toHaveBeenCalledOnce();
    expect(cleanup).toBeTypeOf("function");
    expect(document.getElementById("print-root")).not.toBeNull(); // until the dialog is done

    window.dispatchEvent(new Event("afterprint"));
    expect(document.getElementById("print-root")).toBeNull();
    expect(document.getElementById("print-page-style")).toBeNull();
  });

  it("can be cleaned up by hand, more than once", () => {
    const cleanup = printScore(surface(1), DEFAULT_PRINT, () => {})!;
    cleanup();
    cleanup();
    expect(document.getElementById("print-root")).toBeNull();
  });

  it("does nothing when nothing is drawn", () => {
    const print = vi.fn();
    expect(printScore(document.createElement("div"), DEFAULT_PRINT, print)).toBeNull();
    expect(print).not.toHaveBeenCalled();
    expect(document.getElementById("print-root")).toBeNull();
  });

  it("cleans up and reports when printing fails", () => {
    expect(() =>
      printScore(surface(1), DEFAULT_PRINT, () => {
        throw new Error("no printer");
      }),
    ).toThrow("no printer");
    expect(document.getElementById("print-root")).toBeNull();
    expect(document.getElementById("print-page-style")).toBeNull();
  });
});

describe("printScore in the macOS app (#83)", () => {
  it("cleans up and says why when the app refuses to print, as no afterprint comes", async () => {
    const onFailed = vi.fn();
    const refused = new Error("webview.print not allowed");
    printScore(surface(1), DEFAULT_PRINT, () => Promise.reject(refused), onFailed);
    expect(document.getElementById("print-root")).not.toBeNull();
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith(refused));
    expect(document.getElementById("print-root")).toBeNull();
    expect(document.getElementById("print-page-style")).toBeNull();
  });

  it("keeps the copy while the app's print dialog is open", async () => {
    const onFailed = vi.fn();
    printScore(surface(1), DEFAULT_PRINT, () => Promise.resolve(), onFailed);
    await Promise.resolve();
    expect(document.getElementById("print-root")).not.toBeNull();
    window.dispatchEvent(new Event("afterprint"));
    expect(document.getElementById("print-root")).toBeNull();
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("whenDrawn", () => {
  it("waits until the parts have been added and no more come", async () => {
    vi.useFakeTimers();
    const element = document.createElement("div");
    const done = vi.fn();
    void whenDrawn(element).then(done);

    await vi.advanceTimersByTimeAsync(250);
    expect(done).not.toHaveBeenCalled(); // nothing drawn yet

    const part = document.createElement("div");
    part.innerHTML = "<svg></svg>";
    element.append(part);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled(); // one part so far: more may follow
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledWith(true);
    vi.useRealTimers();
  });

  it("gives up when nothing is drawn", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void whenDrawn(document.createElement("div"), 500).then(done);
    await vi.advanceTimersByTimeAsync(800);
    expect(done).toHaveBeenCalledWith(false);
    vi.useRealTimers();
  });
});
