import { describeOpenError, hasScoreExtension, ScoreLoadError } from "@/lib/score/errors";

describe("describeOpenError", () => {
  it.each([
    [
      "unsupported-type",
      /opens Guitar Pro, MusicXML, MIDI, MuseScore, alphaTex, Capella and text tab files \(\.gp3, \.gp4, \.gp5, \.gpx, \.gp, \.mid, \.midi, \.musicxml, \.mxl, \.xml, \.mscx, \.mscz, \.atex, \.capx, \.txt\)/,
    ],
    ["not-a-score", /not a song file Smart Beat can open, or it is damaged/],
    ["too-large", /too large/],
    ["not-found", /could not be found/],
  ])("explains %s errors from the Rust core", (kind, message) => {
    expect(describeOpenError({ kind, message: "raw" })).toMatch(message);
  });

  it("passes other Rust errors through", () => {
    expect(describeOpenError({ kind: "io", message: "Permission denied" })).toBe(
      "Permission denied",
    );
  });

  it("explains files the score reader rejects", () => {
    expect(describeOpenError(new ScoreLoadError("x"))).toMatch(
      /damaged or is in a format Smart Beat can't read/,
    );
  });

  it("falls back to the error text", () => {
    expect(describeOpenError(new Error("boom"))).toBe("boom");
    expect(describeOpenError("plain")).toBe("plain");
  });
});

describe("hasScoreExtension", () => {
  it.each(["a.gp3", "a.gp4", "a.GP5", "b.gpx", "c.gp"])("accepts %s", (name) => {
    expect(hasScoreExtension(name)).toBe(true);
  });

  it.each(["a.pdf", "gp5", "a.gp6", "", "a."])("rejects %s", (name) => {
    expect(hasScoreExtension(name)).toBe(false);
  });
});
