import { describe, expect, it } from "vitest";

import { listZip, readZipEntry } from "@/lib/import/zip";
import { appendZipEntry, crc32, writeZip } from "@/lib/export/zip";

const text = (s: string) => new TextEncoder().encode(s);

describe("ZIP writer", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("writes an archive the reader lists and reads back", async () => {
    const files = [
      { name: "META-INF/container.xml", data: text("<container/>") },
      { name: "score ő.xml", data: text("<score-partwise/>") },
      { name: "empty", data: new Uint8Array(0) },
    ];
    const zip = writeZip(files);
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const entries = listZip(zip);
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const [i, entry] of entries.entries()) {
      expect(entry.method).toBe(0);
      expect(Array.from(await readZipEntry(zip, entry))).toEqual(Array.from(files[i]!.data));
    }
  });

  it("is the same for the same files", () => {
    const files = [{ name: "a.txt", data: text("a") }];
    expect(writeZip(files)).toEqual(writeZip(files));
  });

  it("writes an empty archive", () => {
    expect(listZip(writeZip([]))).toEqual([]);
  });

  it("adds a file to an archive and keeps the others", async () => {
    const files = [
      { name: "a.txt", data: text("a") },
      { name: "b.txt", data: text("bb") },
    ];
    const zip = appendZipEntry(writeZip(files), { name: "c ő.txt", data: text("ccc") });
    const entries = listZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c ő.txt"]);
    const read = await Promise.all(entries.map((e) => readZipEntry(zip, e)));
    expect(read.map((d) => new TextDecoder().decode(d))).toEqual(["a", "bb", "ccc"]);
    expect(appendZipEntry(writeZip([]), { name: "x", data: text("y") })).toEqual(
      writeZip([{ name: "x", data: text("y") }]),
    );
  });
});
