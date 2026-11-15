/**
 * A small ZIP writer for the archive formats Smart Beat saves (compressed
 * MusicXML `.mxl`, MuseScore `.mscz`). Entries are stored as they are, not
 * deflated: the files are XML of a few hundred KB at most, and every reader
 * (including `src/lib/import/zip.ts`) handles stored entries.
 */

export interface ZipFile {
  /** Path inside the archive, with `/` separators. */
  name: string;
  data: Uint8Array;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
/** 1980-01-01 00:00: a fixed time keeps the archive identical for the same song. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
/** General purpose flag: file names are UTF-8. */
const UTF8_NAMES = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 of `data`, as ZIP files store it. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Writes the local header and content of a stored file at `at`; returns where the next starts. */
function putLocal(out: Uint8Array, view: DataView, at: number, file: ZipFile, name: Uint8Array) {
  view.setUint32(at, LOCAL, true);
  view.setUint16(at + 4, 20, true); // version needed
  view.setUint16(at + 6, UTF8_NAMES, true);
  view.setUint16(at + 8, 0, true); // stored
  view.setUint16(at + 10, DOS_TIME, true);
  view.setUint16(at + 12, DOS_DATE, true);
  view.setUint32(at + 14, crc32(file.data), true);
  view.setUint32(at + 18, file.data.length, true);
  view.setUint32(at + 22, file.data.length, true);
  view.setUint16(at + 26, name.length, true);
  view.setUint16(at + 28, 0, true); // no extra field
  out.set(name, at + 30);
  out.set(file.data, at + 30 + name.length);
  return at + 30 + name.length + file.data.length;
}

/** Writes the central directory entry of a stored file whose local header is at `offset`. */
function putCentral(
  out: Uint8Array,
  view: DataView,
  at: number,
  file: ZipFile,
  name: Uint8Array,
  offset: number,
) {
  view.setUint32(at, CENTRAL, true);
  view.setUint16(at + 4, 20, true); // version made by
  view.setUint16(at + 6, 20, true); // version needed
  view.setUint16(at + 8, UTF8_NAMES, true);
  view.setUint16(at + 10, 0, true); // stored
  view.setUint16(at + 12, DOS_TIME, true);
  view.setUint16(at + 14, DOS_DATE, true);
  view.setUint32(at + 16, crc32(file.data), true);
  view.setUint32(at + 20, file.data.length, true);
  view.setUint32(at + 24, file.data.length, true);
  view.setUint16(at + 28, name.length, true);
  // Extra field, comment, disk number and attributes: all zero.
  view.setUint32(at + 42, offset, true);
  out.set(name, at + 46);
  return at + 46 + name.length;
}

/** A ZIP archive holding `files` in the given order. */
export function writeZip(files: readonly ZipFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const named = files.map((file) => ({ ...file, bytes: encoder.encode(file.name) }));
  const localSize = named.reduce((sum, f) => sum + 30 + f.bytes.length + f.data.length, 0);
  const centralSize = named.reduce((sum, f) => sum + 46 + f.bytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);

  let at = 0;
  const offsets: number[] = [];
  for (const file of named) {
    offsets.push(at);
    at = putLocal(out, view, at, file, file.bytes);
  }

  const centralStart = at;
  named.forEach((file, i) => {
    at = putCentral(out, view, at, file, file.bytes, offsets[i]!);
  });

  view.setUint32(at, EOCD, true);
  view.setUint16(at + 8, named.length, true);
  view.setUint16(at + 10, named.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

/**
 * The archive with one more file (stored) at the end. The other files are copied as they are,
 * deflated or not, so this works on any archive (e.g. the one alphaTab writes).
 */
export function appendZipEntry(zip: Uint8Array, file: ZipFile): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a ZIP archive.");
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralStart = view.getUint32(end + 16, true);
  const name = new TextEncoder().encode(file.name);
  const comment = zip.subarray(end + 22);
  const newCentral = 46 + name.length;
  const out = new Uint8Array(
    centralStart +
      30 +
      name.length +
      file.data.length +
      centralSize +
      newCentral +
      22 +
      comment.length,
  );
  const outView = new DataView(out.buffer);
  out.set(zip.subarray(0, centralStart), 0);
  let at = putLocal(out, outView, centralStart, file, name);
  const newCentralStart = at;
  out.set(zip.subarray(centralStart, centralStart + centralSize), at);
  at += centralSize;
  at = putCentral(out, outView, at, file, name, centralStart);
  out.set(zip.subarray(end, end + 22), at);
  outView.setUint16(at + 8, count + 1, true);
  outView.setUint16(at + 10, count + 1, true);
  outView.setUint32(at + 12, centralSize + newCentral, true);
  outView.setUint32(at + 16, newCentralStart, true);
  out.set(comment, at + 22);
  return out;
}
