import { defaultEncoding, detectEncoding, encodeText, encodingFor } from "@/lib/score/encoding";

const bytes = (text: string, encoding: "windows-1250" | "windows-1252" | "utf-8") =>
  encodeText(text, encoding).bytes;

describe("text encodings of Guitar Pro 3–5 files (#53)", () => {
  it("encodes Hungarian names in Windows-1250 and loses nothing", () => {
    const { bytes: data, lost } = encodeText("Ütős hangszer", "windows-1250");
    expect(lost).toBe(0);
    expect(new TextDecoder("windows-1250").decode(data)).toBe("Ütős hangszer");
    expect(data[2]).toBe(0xf5); // ő
  });

  it("writes characters a code page lacks as ? and counts them", () => {
    expect(encodeText("Ősz ♪", "windows-1252")).toMatchObject({ lost: 2 });
    expect(new TextDecoder("windows-1252").decode(encodeText("Ősz ♪", "windows-1252").bytes)).toBe(
      "?sz ?",
    );
  });

  it("keeps every byte through Windows-1252, so stored strings can be rebuilt", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = new TextDecoder("windows-1252").decode(all);
    expect(encodeText(text, "windows-1252").bytes).toEqual(all);
  });

  it("detects Central European text", () => {
    const names = ["Ütős hangszer", "Szóló 1", "Őszi dal"].map((t) => bytes(t, "windows-1250"));
    expect(detectEncoding(names, "en-US")).toBe("windows-1250");
  });

  it("detects Western text", () => {
    const names = ["Café del Mar", "Señor", "Déjà vu"].map((t) => bytes(t, "windows-1252"));
    expect(detectEncoding(names, "hu-HU")).toBe("windows-1252");
  });

  it("detects UTF-8 (files saved by older Smart Beat versions)", () => {
    expect(detectEncoding([bytes("Ütős hangszer", "utf-8")])).toBe("utf-8");
  });

  it("uses Windows-1252 for plain ASCII files", () => {
    expect(detectEncoding([bytes("Guitar", "utf-8")])).toBe("windows-1252");
  });

  it("breaks ties with the user's language", () => {
    // á, é and ü are the same in both code pages.
    const same = [bytes("Gitár és dob", "windows-1250")];
    expect(detectEncoding(same, "hu-HU")).toBe("windows-1250");
    expect(detectEncoding(same, "en-GB")).toBe("windows-1252");
    expect(defaultEncoding("cs-CZ")).toBe("windows-1250");
    expect(defaultEncoding("de-DE")).toBe("windows-1252");
  });

  it("saves in a code page the text fits in", () => {
    expect(encodingFor(["Ősz"], "windows-1252")).toBe("windows-1250");
    expect(encodingFor(["Señor"], "windows-1250")).toBe("windows-1252");
    expect(encodingFor(["Guitar"], "windows-1250")).toBe("windows-1250");
    // Neither holds both: keep the song's own one.
    expect(encodingFor(["Ősz", "Señor"], "windows-1250")).toBe("windows-1250");
    expect(encodingFor(["♪"], "utf-8")).toBe("utf-8");
  });
});
