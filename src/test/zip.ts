import { deflateRawSync } from "node:zlib";

/** A ZIP archive (for tests): each file stored or deflated. */
export function makeZip(files: { name: string; data: Uint8Array; deflate: boolean }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const packed = file.deflate ? new Uint8Array(deflateRawSync(file.data)) : file.data;
    const method = file.deflate ? 8 : 0;
    const local = Uint8Array.from([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(packed.length),
      ...u32(file.data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    chunks.push(local, packed);
    central.push(
      Uint8Array.from([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(method),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(packed.length),
        ...u32(file.data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ]),
    );
    offset += local.length + packed.length;
  }
  const directory = central.reduce((total, c) => total + c.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(directory),
    ...u32(offset),
    ...u16(0),
  ]);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((total, c) => total + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
