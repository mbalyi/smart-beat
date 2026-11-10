/**
 * The data fields a peer may set on each kind of score part.
 *
 * An operation from another computer names the fields it sets, and a modified app could name
 * anything: a method of the part (`finish`), a name nothing reads or a value of the wrong type
 * would poison the part, and the next edit on it would throw. So only the data fields of the part
 * are accepted, found on a fresh part of the same class, with the type their default has.
 */
import { model } from "@coderline/alphatab";

import type { Node } from "@/lib/score/ops/types";

/** The kind of a part, as a node names it. */
export type PartKind = Node["k"];

const FRESH: Record<PartKind, () => object> = {
  track: () => new model.Track(),
  staff: () => new model.Staff(),
  mbar: () => new model.MasterBar(),
  bar: () => new model.Bar(),
  voice: () => new model.Voice(),
  beat: () => new model.Beat(),
  note: () => new model.Note(),
};

/** Data fields that alphaTab's classes do not declare but this app puts on a part. */
const EXTRA: Partial<Record<PartKind, readonly string[]>> = {
  track: ["smartBeatLyrics"],
};

const defaultsByKind = new Map<PartKind, ReadonlyMap<string, unknown>>();

/** The own data fields of a fresh part of `kind`, with their default values. */
function defaultsOf(kind: PartKind): ReadonlyMap<string, unknown> {
  let defaults = defaultsByKind.get(kind);
  if (!defaults) {
    const fields = new Map<string, unknown>(Object.entries(FRESH[kind]()));
    for (const key of EXTRA[kind] ?? []) if (!fields.has(key)) fields.set(key, undefined);
    defaults = fields;
    defaultsByKind.set(kind, defaults);
  }
  return defaults;
}

/** Whether `key` is a data field of the part (never a method, accessor or an unknown name). */
export function isDataField(kind: PartKind, key: string): boolean {
  return defaultsOf(kind).has(key);
}

const isPlainKind = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Map) &&
  !(value instanceof Set);

/**
 * Whether `value` is the kind of value the field holds. A field that starts out as a number,
 * text or flag stays one; one that holds a list, map, set or object of some class keeps to it.
 * A field that starts out empty (null or undefined) holds whatever alphaTab puts there.
 */
export function fitsField(kind: PartKind, key: string, value: unknown): boolean {
  const fallback = defaultsOf(kind).get(key);
  if (fallback === null || fallback === undefined) return true;
  switch (typeof fallback) {
    case "number":
    case "string":
    case "boolean":
      return typeof value === typeof fallback;
    case "object":
      if (Array.isArray(fallback)) return Array.isArray(value);
      if (fallback instanceof Map) return value instanceof Map;
      if (fallback instanceof Set) return value instanceof Set;
      return isPlainKind(value) && Object.getPrototypeOf(value) === Object.getPrototypeOf(fallback);
    default:
      return false;
  }
}

/** The kind of a part of the score; undefined for anything else. */
export function kindOf(part: unknown): PartKind | undefined {
  if (part instanceof model.Track) return "track";
  if (part instanceof model.Staff) return "staff";
  if (part instanceof model.MasterBar) return "mbar";
  if (part instanceof model.Bar) return "bar";
  if (part instanceof model.Voice) return "voice";
  if (part instanceof model.Beat) return "beat";
  if (part instanceof model.Note) return "note";
  return undefined;
}
