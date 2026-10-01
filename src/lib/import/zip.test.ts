import { deflateRawSync } from "node:zlib";

import { listZip, readZipEntry } from "@/lib/import/zip";
import { makeZip } from "@/test/zip";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("zip reader", () => {
  it("lists and reads stored and deflated files", async () => {
    const bytes = makeZip([
      { name: "a.txt", data: new TextEncoder().encode("stored text"), deflate: false },
      { name: "folder/b.mscx", data: new TextEncoder().encode("<xml>".repeat(200)), deflate: true },
    ]);

    const entries = listZip(bytes);

    expect(entries.map((e) => e.name)).toEqual(["a.txt", "folder/b.mscx"]);
    expect(text(await readZipEntry(bytes, entries[0]!))).toBe("stored text");
    expect(text(await readZipEntry(bytes, entries[1]!))).toBe("<xml>".repeat(200));
  });

  it("refuses data that is not an archive", () => {
    expect(() => listZip(new TextEncoder().encode("just some text, not a zip"))).toThrow(
      "not a valid archive",
    );
  });

  it("refuses a damaged file list and damaged entries", async () => {
    const bytes = makeZip([{ name: "a.txt", data: new Uint8Array([1, 2, 3]), deflate: false }]);
    const broken = bytes.slice();
    broken[bytes.length - 22 + 16] = 0xff; // the file list starts beyond the end
    expect(() => listZip(broken)).toThrow("damaged");

    const entry = listZip(bytes)[0]!;
    const noHeader = bytes.slice();
    noHeader[0] = 0;
    await expect(readZipEntry(noHeader, entry)).rejects.toThrow("damaged");

    const bad = makeZip([{ name: "x", data: new Uint8Array([1]), deflate: false }]);
    const badEntry = { ...listZip(bad)[0]!, method: 8 };
    await expect(readZipEntry(bad, badEntry)).rejects.toThrow("damaged");
    await expect(readZipEntry(bad, { ...badEntry, method: 12 })).rejects.toThrow("compression");
    await expect(readZipEntry(bad, { ...badEntry, size: 1e9 })).rejects.toThrow("too large");
  });

  it("deflate helper of the tests produces what the reader expects", () => {
    expect(deflateRawSync(new Uint8Array([1, 2, 3])).length).toBeGreaterThan(0);
  });
});
