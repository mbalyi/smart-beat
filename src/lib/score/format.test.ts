import { baseName, describeTime, fileKey, formatTime } from "@/lib/score/format";

describe("formatTime", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [12_000, "0:12"],
    [65_500, "1:05"],
    [3_725_000, "1:02:05"],
    [-5, "0:00"],
  ])("formats %i ms as %s", (ms, text) => {
    expect(formatTime(ms)).toBe(text);
  });
});

describe("describeTime", () => {
  it.each([
    [0, "0 seconds"],
    [1_000, "1 second"],
    [60_000, "1 minute"],
    [125_000, "2 minutes 5 seconds"],
  ])("reads %i ms as %s", (ms, text) => {
    expect(describeTime(ms)).toBe(text);
  });
});

describe("fileKey", () => {
  it("is the lowercase hex SHA-256 of the content", async () => {
    await expect(fileKey(new TextEncoder().encode("test"))).resolves.toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });
});

describe("baseName", () => {
  it.each([
    ["/Users/me/Songs/solo.gp5", "solo.gp5"],
    ["C:\\Songs\\solo.gp", "solo.gp"],
    ["solo.gpx", "solo.gpx"],
    ["/weird/", "/weird/"],
  ])("%s → %s", (path, name) => {
    expect(baseName(path)).toBe(name);
  });
});
