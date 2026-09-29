/**
 * Snapshots of alphaTab model objects, for undo and redo.
 *
 * alphaTab has no editing API: the editor changes its model objects directly.
 * A snapshot records the own properties of a set of objects (arrays, maps and
 * sets are copied one level deep) and can write them back later. Restoring
 * onto the same objects keeps every reference to them valid, and nothing is
 * serialized, so effects the editor doesn't know about (bends, slides...)
 * survive undo and redo untouched.
 *
 * Properties that alphaTab derives from the model (links between beats, tick
 * positions...) are restored too, but {@link refinish} recomputes them anyway.
 */

type Props = Record<string, unknown>;

function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value instanceof Map) return new Map(value);
  if (value instanceof Set) return new Set(value);
  return value;
}

export class Snapshot {
  private readonly saved: ReadonlyMap<object, Props>;

  private constructor(saved: ReadonlyMap<object, Props>) {
    this.saved = saved;
  }

  /** Records the current state of `targets` (duplicates are recorded once). */
  static of(targets: Iterable<object>): Snapshot {
    const saved = new Map<object, Props>();
    for (const target of targets) {
      if (saved.has(target)) continue;
      const props: Props = {};
      for (const [key, value] of Object.entries(target)) props[key] = copyValue(value);
      saved.set(target, props);
    }
    return new Snapshot(saved);
  }

  /** Number of objects recorded. */
  get size(): number {
    return this.saved.size;
  }

  /** Writes the recorded state back. Can be called any number of times. */
  restore(): void {
    for (const [target, props] of this.saved) {
      const record = target as Props;
      for (const [key, value] of Object.entries(props)) record[key] = copyValue(value);
    }
  }
}
