import type { Page } from "@playwright/test";

import {
  emitMenuAction,
  expect,
  expectNoA11yViolations as expectNoA11y,
  openSong,
  test,
} from "./fixtures";

declare global {
  interface Window {
    __printCalls: number;
  }
}

/** Audio (WAV) export and Print / PDF (#17), with the real synthesizer and renderer. */

test.describe("audio export (#17)", () => {
  test("renders the song with the mix to a WAV file", async ({ app }) => {
    await openSong(app); // 12 seconds long
    await app.evaluate(() => (window.__saveResult = "/Users/me/Music/mix"));

    await app.getByRole("button", { name: "File" }).click();
    await app.getByRole("menuitem", { name: "Audio (WAV)…" }).click();

    await expect
      .poll(
        () => app.evaluate(() => window.__written.get("/Users/me/Music/mix.wav")?.length ?? 0),
        {
          timeout: 60_000,
        },
      )
      .toBeGreaterThan(1_000_000);
    const wav = await app.evaluate(() => {
      const bytes = window.__written.get("/Users/me/Music/mix.wav")!;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let loudest = 0;
      for (let i = 44; i + 1 < bytes.length; i += 2)
        loudest = Math.max(loudest, Math.abs(view.getInt16(i, true)));
      return {
        riff: String.fromCharCode(...bytes.slice(0, 4)),
        wave: String.fromCharCode(...bytes.slice(8, 12)),
        channels: view.getUint16(22, true),
        rate: view.getUint32(24, true),
        seconds: (bytes.length - 44) / (view.getUint32(28, true) || 1),
        loudest,
      };
    });
    expect(wav).toMatchObject({ riff: "RIFF", wave: "WAVE", channels: 2, rate: 44_100 });
    expect(wav.seconds).toBeGreaterThan(11);
    expect(wav.seconds).toBeLessThan(14);
    expect(wav.loudest).toBeGreaterThan(500); // there is music in it
    await expect(app.getByText("Exported “mix.wav”").first()).toBeVisible();
  });

  test("renders the same song to an M4A file through the system encoder", async ({ app }) => {
    await openSong(app); // 12 seconds long
    await app.evaluate(() => (window.__saveResult = "/Users/me/Music/mix"));

    await app.getByRole("button", { name: "File" }).click();
    await app.getByRole("menuitem", { name: "Audio (M4A)…" }).click();

    // The mock keeps the WAV that the real command turns into AAC.
    await expect
      .poll(
        () => app.evaluate(() => window.__written.get("/Users/me/Music/mix.m4a")?.length ?? 0),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(1_000_000);
    const sent = await app.evaluate(() => {
      const bytes = window.__written.get("/Users/me/Music/mix.m4a")!;
      return {
        riff: String.fromCharCode(...bytes.slice(0, 4)),
        commands: window.__ipcCalls.map((c) => c.cmd),
      };
    });
    expect(sent.riff).toBe("RIFF");
    expect(sent.commands).toContain("export_m4a");
    await expect(app.getByText("Exported “mix.m4a”").first()).toBeVisible();
  });

  test("the native menu action exports M4A too", async ({ app }) => {
    await openSong(app);
    await app.evaluate(() => (window.__saveResult = "/Users/me/Music/native.m4a"));
    await emitMenuAction(app, "export-audio-m4a");
    await expect
      .poll(
        () => app.evaluate(() => window.__written.get("/Users/me/Music/native.m4a")?.length ?? 0),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(1_000_000);
  });

  test("a muted track is left out of the export", async ({ app }) => {
    await openSong(app);
    const peak = async (path: string) => {
      await app.evaluate((p) => (window.__saveResult = p), path);
      await app.getByRole("button", { name: "File" }).click();
      await app.getByRole("menuitem", { name: "Audio (WAV)…" }).click();
      await expect
        .poll(() => app.evaluate((p) => window.__written.get(p)?.length ?? 0, path), {
          timeout: 60_000,
        })
        .toBeGreaterThan(1_000_000);
      return app.evaluate((p) => {
        const bytes = window.__written.get(p)!;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let sum = 0;
        for (let i = 44; i + 1 < bytes.length; i += 2) sum += Math.abs(view.getInt16(i, true));
        return sum;
      }, path);
    };

    const all = await peak("/Users/me/Music/all.wav");
    for (const track of ["Guitar", "Bass", "Drums"]) {
      await app.getByRole("button", { name: `Mute ${track}` }).click();
    }
    const pianoOnly = await peak("/Users/me/Music/piano.wav"); // the piano is muted in the file, so muted twice over

    expect(pianoOnly).toBeLessThan(all * 0.25);
  });
});

test.describe("print and PDF (#17)", () => {
  test.beforeEach(async ({ app }) => {
    await app.evaluate(() => {
      window.__printCalls = 0;
      window.print = () => {
        window.__printCalls++;
      };
    });
  });

  async function openPrintDialog(app: Page) {
    await app.getByRole("button", { name: "File" }).click();
    await app.getByRole("menuitem", { name: "Print / PDF…" }).click();
    return app.getByRole("dialog", { name: "Print or save as PDF" });
  }

  test("prints the score on A4 pages, and the PDF holds the notation", async ({
    app,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Only Chromium can make a PDF from a test");
    await openSong(app);

    const dialog = await openPrintDialog(app);
    await dialog.getByRole("button", { name: "Print…" }).click();
    await expect.poll(() => app.evaluate(() => window.__printCalls)).toBe(1);

    // While the print dialog is open, only the copy of the score is printed.
    expect(await app.locator("#print-root svg").count()).toBeGreaterThan(0);
    await expect(app.locator("#print-root")).toBeHidden(); // not on screen
    const pdf = await app.pdf({ preferCSSPageSize: true });
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF")).toBe(true);
    expect(text).toMatch(/\/MediaBox \[0 0 59[45]\.\d+ 841\.\d+\]/); // A4 portrait
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(pdf.length).toBeGreaterThan(5_000);

    await app.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(app.locator("#print-root")).toHaveCount(0);
  });

  test("uses the chosen paper and orientation", async ({ app, browserName }) => {
    test.skip(browserName !== "chromium", "Only Chromium can make a PDF from a test");
    await openSong(app);

    const dialog = await openPrintDialog(app);
    await dialog.getByRole("combobox", { name: "Paper size" }).click();
    await app.getByRole("option", { name: "Letter" }).click();
    await dialog.getByRole("combobox", { name: "Orientation" }).click();
    await app.getByRole("option", { name: "Landscape" }).click();
    await dialog.getByRole("button", { name: "Print…" }).click();
    await expect.poll(() => app.evaluate(() => window.__printCalls)).toBe(1);

    const text = (await app.pdf({ preferCSSPageSize: true })).toString("latin1");
    expect(text).toMatch(/\/MediaBox \[0 0 792(\.0+)? 612(\.0+)?\]/); // Letter landscape
  });

  test("switches the continuous layout to pages for the print", async ({ app }) => {
    await openSong(app);
    await app.getByRole("radio", { name: "Continuous" }).click();

    const dialog = await openPrintDialog(app);
    await dialog.getByRole("button", { name: "Print…" }).click();

    await expect.poll(() => app.evaluate(() => window.__printCalls)).toBe(1);
    await app.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(app.getByRole("radio", { name: "Continuous" })).toBeChecked(); // back to what it was
  });

  test("opens with Ctrl+P and has no WCAG violations", async ({ app }) => {
    await openSong(app);
    await app.getByRole("region", { name: /^Score:/ }).focus();
    await app.keyboard.press(process.platform === "darwin" ? "Meta+p" : "Control+p");
    const dialog = app.getByRole("dialog", { name: "Print or save as PDF" });
    await expect(dialog).toBeVisible();
    await expectNoA11y(app);
  });

  test("Export as PDF saves the score where the user chose, with a clear message (#83)", async ({
    app,
  }) => {
    await openSong(app);
    await app.evaluate(() => (window.__saveResult = "/Users/me/Music/practice-song.pdf"));
    const dialog = await openPrintDialog(app);
    await expect(dialog).toContainText("Export as PDF saves a PDF file where you choose");
    await dialog.getByRole("combobox", { name: "Orientation" }).click();
    await app.getByRole("option", { name: "Landscape" }).click();
    await dialog.getByRole("button", { name: "Export as PDF…" }).click();

    await expect(app.getByText("Exported “practice-song.pdf”")).toBeVisible();
    await expect(app.getByText("/Users/me/Music/practice-song.pdf")).toBeVisible();
    const exports = await app.evaluate(() => window.__pdfExports ?? []);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({
      path: "/Users/me/Music/practice-song.pdf",
      page: { widthPt: 595.28, heightPt: 841.89, landscape: true },
    });
    // The print copy was in place while macOS printed it, and is gone afterwards.
    expect(exports[0]!.parts).toBeGreaterThan(0);
    await expect(app.locator("#print-root")).toHaveCount(0);
    // No system print dialog.
    expect(await app.evaluate(() => window.__printCalls)).toBe(0);
  });

  test("Export as PDF says why it failed (#83)", async ({ app }) => {
    await openSong(app);
    await app.evaluate(() => {
      window.__saveResult = "/Users/me/Music/song.pdf";
      window.__pdfFail = "The disk is full.";
    });
    await emitMenuAction(app, "export-pdf");
    await expect(app.getByText("Couldn't export the PDF")).toBeVisible();
    await expect(app.getByText("The disk is full.")).toBeVisible();
    await expect(app.locator("#print-root")).toHaveCount(0);
  });

  test("a print the app refuses is reported, not silently dropped (#83)", async ({ app }) => {
    await openSong(app);
    await app.getByRole("radio", { name: "Continuous" }).click();
    await app.evaluate(() => {
      window.print = () => Promise.reject(new Error("Printing is not allowed.")) as never;
    });
    const dialog = await openPrintDialog(app);
    await dialog.getByRole("button", { name: "Print…" }).click();
    await expect(app.getByText("Couldn't print")).toBeVisible();
    await expect(app.getByText(/Printing is not allowed\./)).toBeVisible();
    await expect(app.locator("#print-root")).toHaveCount(0);
    // The screen layout came back without an afterprint event.
    await expect(app.getByRole("radio", { name: "Continuous" })).toBeChecked();
  });

  test("File › Print… (native menu) prints every track as a full score", async ({ app }) => {
    await openSong(app);
    await app.evaluate(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => {
        const w = window as unknown as { __printed: number };
        w.__printed = document.querySelectorAll("#print-root svg").length;
        window.dispatchEvent(new Event("afterprint"));
      };
    });
    await emitMenuAction(app, "print");
    const dialog = app.getByRole("dialog", { name: "Print or save as PDF" });
    await dialog.getByRole("radio", { name: /^All \d+ tracks/ }).check();
    await dialog.getByRole("button", { name: "Print…" }).click();
    await expect
      .poll(() => app.evaluate(() => (window as unknown as { __printed: number }).__printed), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    // Back to the shown track afterwards.
    await expect(app.getByRole("region", { name: "Score: Guitar" })).toBeVisible();
  });
});
