import { exportGroups } from "@/lib/export/choices";
import { SAVE_EXTENSIONS } from "@/lib/tauri";

const all = (opts = { m4a: true, pdf: true }) =>
  exportGroups(opts).flatMap((group) => group.choices);

describe("exportGroups", () => {
  it("lists every format the build writes, GP5 included, with its extension", () => {
    const extensions = all().map((c) => c.extension);
    expect(extensions).toEqual([
      "gp",
      "gp5",
      "gp4",
      "gp3",
      "mscz",
      "mscx",
      "musicxml",
      "mxl",
      "mid",
      "atex",
      "txt",
      "wav",
      "m4a",
      "pdf",
    ]);
    expect(all().find((c) => c.id === "gp5")?.label).toBe("Guitar Pro 5");
  });

  it("only lists M4A and PDF where they can be written", () => {
    const ids = all({ m4a: false, pdf: false }).map((c) => c.id);
    expect(ids).not.toContain("m4a");
    expect(ids).not.toContain("pdf");
    expect(ids).toContain("wav");
  });

  it("only lists song and notation files the native side can write", () => {
    const writable = new Set<string>(SAVE_EXTENSIONS);
    for (const choice of all()) {
      if (choice.target.kind === "format") expect(writable).toContain(choice.extension);
    }
  });

  it("gives every entry a unique id and a note", () => {
    const choices = all();
    expect(new Set(choices.map((c) => c.id)).size).toBe(choices.length);
    for (const choice of choices) expect(choice.note.length).toBeGreaterThan(5);
  });
});
