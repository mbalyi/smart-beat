/**
 * A small ZIP reader (for MuseScore's `.mscz`): the central directory lists
 * the files, which are stored as they are or deflated. Inflating uses the
 * browser's own `DecompressionStream`.
 */
import { ScoreLoadError } from "@/lib/score/errors";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Files bigger than this (unpacked) are not read: a guard against zip bombs. */
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
}

/** The files in a ZIP archive, in the order of its central directory. */
export function listZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // The end record is in the last 64 KB (it can carry a comment).
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ScoreLoadError("The file is not a valid archive.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) {
      throw new ScoreLoadError("The archive's file list is damaged.");
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflates raw deflate data. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const stream = source.pipeThrough(
    new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The content of one file of an archive. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.size > MAX_ENTRY_BYTES) throw new ScoreLoadError("The file inside is too large.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL) {
    throw new ScoreLoadError("The archive is damaged.");
  }
  const start =
    entry.offset +
    30 +
    view.getUint16(entry.offset + 26, true) +
    view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    try {
      return await inflate(data);
    } catch (error) {
      throw new ScoreLoadError("The archive is damaged.", { cause: error });
    }
  }
  throw new ScoreLoadError("The archive uses a compression Smart Beat can't read.");
}
