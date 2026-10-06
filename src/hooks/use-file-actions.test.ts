import { audioExportProblem } from "@/hooks/use-file-actions";

describe("audio export", () => {
  it("lets a browser export WAV but not M4A (the encoder is in the desktop app)", () => {
    expect(audioExportProblem("wav", false)).toBeNull();
    expect(audioExportProblem("m4a", false)).toBe(
      "M4A export needs the desktop app. Export a WAV file instead.",
    );
  });

  it("lets the desktop app export both", () => {
    expect(audioExportProblem("wav", true)).toBeNull();
    expect(audioExportProblem("m4a", true)).toBeNull();
  });
});
