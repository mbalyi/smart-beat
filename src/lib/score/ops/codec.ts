/**
 * Turns the properties of alphaTab model objects into JSON and back.
 *
 * Only an element's own data travels: links to other model objects (parent, neighbours, tie
 * partners) and values alphaTab derives (ids, indexes, lookup maps, extreme bend points) stay out,
 * because `refinish` rebuilds them after every change. Nested helper objects (bend points,
 * automations, a tuning...) are tagged with the name of their alphaTab class.
 */
import { model } from "@coderline/alphatab";

import { PERSONAL, type Json, type Props } from "@/lib/score/ops/types";
import { FORBIDDEN_KEYS } from "@/lib/score/ops/validate";

const MODEL_TYPES: (new (...args: never[]) => object)[] = [
  model.Score,
  model.Track,
  model.Staff,
  model.MasterBar,
  model.Bar,
  model.Voice,
  model.Beat,
  model.Note,
  model.TupletGroup,
  model.GraceGroup,
];

const isModelObject = (value: unknown) => MODEL_TYPES.some((Type) => value instanceof Type);

/** alphaTab classes by export name, and back: minified builds rename classes, so the name comes from here. */
const CLASSES = new Map<string, new () => object>();
const CLASS_NAMES = new Map<unknown, string>();
for (const [name, value] of Object.entries(model)) {
  if (typeof value !== "function") continue;
  CLASSES.set(name, value as new () => object);
  CLASS_NAMES.set(value, name);
}

/** Properties that are derived or internal, never shared. */
const DERIVED = new Set([
  "id",
  "index",
  "_noteIdBag",
  "effectSlur",
  "noteValueLookup",
  "noteStringLookup",
  "maxBendPoint",
  "maxWhammyPoint",
  "minWhammyPoint",
  // Positions alphaTab computes from the music (`finish`).
  "start",
  "displayStart",
  "displayDuration",
  "playbackStart",
  "playbackDuration",
  "absoluteDisplayStart",
  "absolutePlaybackStart",
]);

/** The list properties of each element that are their own elements (see ops/diff.ts). */
const CHILDREN: ReadonlyMap<unknown, readonly string[]> = new Map<unknown, readonly string[]>([
  [model.Track, ["staves"]],
  [model.Staff, ["bars"]],
  [model.Bar, ["voices"]],
  [model.Voice, ["beats"]],
  [model.Beat, ["notes"]],
]);

const SKIP = Symbol("skip");
const UNDEFINED = { $u: 1 };

function encode(value: unknown, path: Set<object>): Json | typeof SKIP {
  if (value === undefined) return UNDEFINED;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $n: String(value) };
  if (typeof value !== "object") return SKIP;
  if (isModelObject(value) || path.has(value)) return SKIP;
  path.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => encode(item, path));
      return items.includes(SKIP) ? SKIP : items;
    }
    if (value instanceof Map) {
      const entries: Json[] = [];
      for (const [key, item] of value) {
        const encoded = encode(item, path);
        if (encoded === SKIP) return SKIP;
        entries.push([key, encoded]);
      }
      return { $m: entries };
    }
    if (value instanceof Set) {
      const items = [...value].map((item) => encode(item, path));
      return items.includes(SKIP) ? SKIP : { $s: items };
    }
    const proto = Object.getPrototypeOf(value) as object | null;
    const name = proto === Object.prototype ? "Object" : CLASS_NAMES.get(proto?.constructor);
    if (!name) return SKIP;
    const props: Props = {};
    for (const [key, item] of Object.entries(value)) {
      const encoded = encode(item, path);
      if (encoded !== SKIP) props[key] = encoded;
    }
    return { $c: name, p: props };
  } finally {
    path.delete(value);
  }
}

/** An operation that cannot be a real one: it is refused as a whole (see `validOps`). */
class BadEdit extends Error {}

/** Properties a peer may not set: links between parts, lists of parts and what alphaTab derives. */
const NOT_SETTABLE: ReadonlySet<string> = new Set([
  ...FORBIDDEN_KEYS,
  ...DERIVED,
  "score",
  "masterBar",
  "track",
  "staff",
  "bar",
  "voice",
  "beat",
  "note",
  "staves",
  "bars",
  "voices",
  "beats",
  "notes",
  "previousBeat",
  "nextBeat",
  "previousBar",
  "nextBar",
  "previousMasterBar",
  "nextMasterBar",
  "tupletGroup",
  "graceGroup",
]);

/** Classes that are parts of the score: only a part's own data travels, never a part. */
const PART_CLASS_NAMES: ReadonlySet<string> = new Set(
  MODEL_TYPES.map((Type) => CLASS_NAMES.get(Type) ?? ""),
);

const MAX_DEPTH = 40;

function decode(value: Json, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) throw new BadEdit();
  if (Array.isArray(value)) return value.map((item) => decode(item, depth + 1));
  const tagged = value as {
    $u?: 1;
    $n?: string;
    $m?: unknown;
    $s?: unknown;
    $c?: string;
    p?: Props;
  };
  if (tagged.$u) return undefined;
  if (tagged.$n !== undefined) return Number(tagged.$n);
  if (tagged.$m !== undefined) {
    if (!Array.isArray(tagged.$m)) throw new BadEdit();
    return new Map(
      tagged.$m.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) throw new BadEdit();
        return [entry[0], decode(entry[1] as Json, depth + 1)];
      }),
    );
  }
  if (tagged.$s !== undefined) {
    if (!Array.isArray(tagged.$s)) throw new BadEdit();
    return new Set(tagged.$s.map((item) => decode(item as Json, depth + 1)));
  }
  if (tagged.$c === undefined) return value;
  const known =
    tagged.$c === "Object" || (CLASSES.has(tagged.$c) && !PART_CLASS_NAMES.has(tagged.$c));
  if (!known || (tagged.p !== undefined && (typeof tagged.p !== "object" || tagged.p === null))) {
    throw new BadEdit();
  }
  const target =
    tagged.$c === "Object"
      ? {}
      : Object.create(CLASSES.get(tagged.$c)?.prototype ?? Object.prototype);
  for (const [key, item] of Object.entries(tagged.p ?? {})) {
    if (FORBIDDEN_KEYS.has(key)) throw new BadEdit();
    (target as Record<string, unknown>)[key] = decode(item, depth + 1);
  }
  return target;
}

/** Keys of `element` that are not shared (see {@link PERSONAL}). */
function personalKeys(element: object): readonly string[] {
  if (element instanceof model.Staff) return PERSONAL.staff;
  if (element instanceof model.PlaybackInformation) return PERSONAL.playbackInfo;
  return [];
}

/** The shareable own properties of an element, without its child lists. */
export function encodeProps(element: object): Props {
  const skipped = new Set([...DERIVED, ...(CHILDREN.get(element.constructor) ?? [])]);
  const props: Props = {};
  for (const [key, value] of Object.entries(element)) {
    if (skipped.has(key)) continue;
    let encoded: Json | typeof SKIP;
    if (key === "playbackInfo" && element instanceof model.Track) {
      // A player's own volume, balance, mute and solo stay out of the shared value.
      const info = value as model.PlaybackInformation;
      const hidden = new Set<string>(personalKeys(info));
      const shared: Props = {};
      for (const [infoKey, infoValue] of Object.entries(info)) {
        const item = hidden.has(infoKey) ? SKIP : encode(infoValue, new Set());
        if (item !== SKIP) shared[infoKey] = item;
      }
      encoded = { $c: "PlaybackInformation", p: shared };
    } else {
      encoded = encode(value, new Set());
    }
    if (encoded !== SKIP && !personalKeys(element).includes(key)) props[key] = encoded;
  }
  return props;
}

/** Throws when `props` cannot be written onto an element (so nothing is changed half way). */
export function checkProps(props: Props): void {
  for (const [key, encoded] of Object.entries(props)) {
    if (!NOT_SETTABLE.has(key)) decode(encoded);
  }
}

/** Writes encoded properties onto an element. Nested objects of the same class are updated in place. */
export function assignProps(element: object, props: Props): void {
  const record = element as Record<string, unknown>;
  for (const [key, encoded] of Object.entries(props)) {
    // Links, lists of parts and derived values are never taken from another computer.
    if (NOT_SETTABLE.has(key)) continue;
    const value = decode(encoded);
    const current = record[key];
    if (
      current &&
      value &&
      typeof current === "object" &&
      typeof value === "object" &&
      !Array.isArray(current) &&
      !(current instanceof Map) &&
      !(current instanceof Set) &&
      Object.getPrototypeOf(current) === Object.getPrototypeOf(value)
    ) {
      Object.assign(current, value);
    } else {
      record[key] = value;
    }
  }
}

/** The changed keys between two encoded property sets (removed keys become `undefined`). */
export function changedProps(before: Props, after: Props): Props | null {
  const changed: Props = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    // A property that is `null` is not the same as one that is not there.
    const a = JSON.stringify(key in before ? before[key] : UNDEFINED);
    const b = JSON.stringify(key in after ? after[key] : UNDEFINED);
    if (a !== b) changed[key] = key in after ? after[key] : UNDEFINED;
  }
  return Object.keys(changed).length > 0 ? changed : null;
}
