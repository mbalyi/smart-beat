/**
 * Works out which operations an edit made, by comparing the score before and after it.
 *
 * The editor's commands change alphaTab's objects directly, so there is no list of "what the
 * command did". Instead the bars an edit touches (the objects it declares as snapshot targets)
 * are written out before and after, and the two are compared by id: parts that are new are
 * inserted, parts that are gone are deleted, and parts that stayed have their changed properties
 * set. Comparing in both directions also gives the operations that take the edit back.
 *
 * When an edit cannot be described (tracks and bar lines changed together, parts were reordered),
 * the result is a single `reset`: everyone takes the whole tab again, as they did before shared
 * editing. A bar the edit changed without declaring it among its targets cannot be seen (there
 * is nothing to compare it with); the editor declares what each command changes for undo, which
 * this relies on, and the host sending the tab again when copies differ for a while is the net.
 */
import { model } from "@coderline/alphatab";

import { changedProps, encodeProps } from "@/lib/score/ops/codec";
import type { IdRegistry, Part } from "@/lib/score/ops/ids";
import type { Edit, Kind, Node, Op, Props } from "@/lib/score/ops/types";
import type { Bar, Score } from "@/lib/score/model";

/** The structure of a score at one moment, with the full content of the bars an edit touched. */
export interface State {
  tracks: string[];
  staves: Map<string, string[]>;
  masterBars: string[];
  /** Bar ids of each staff, in order. */
  bars: Map<string, string[]>;
  /** Properties of tracks, staves and bar lines. */
  meta: Map<string, Props>;
  /** Full content of the touched bars. */
  content: Map<string, Node>;
}

const CHILD_KIND = { bar: "voice", voice: "beat", beat: "note" } as const;

function uidOf(ids: IdRegistry, part: Part): string {
  const uid = ids.uid(part);
  if (uid === undefined) throw new Error("part without an id");
  return uid;
}

/** A part and everything inside it as a node. */
export function toNode(ids: IdRegistry, part: Part): Node {
  const u = uidOf(ids, part);
  const p = encodeProps(part);
  if (part instanceof model.Note) return { u, k: "note", p };
  if (part instanceof model.Beat)
    return { u, k: "beat", p, c: part.notes.map((n) => toNode(ids, n)) };
  if (part instanceof model.Voice)
    return { u, k: "voice", p, c: part.beats.map((b) => toNode(ids, b)) };
  if (part instanceof model.Bar)
    return { u, k: "bar", p, c: part.voices.map((v) => toNode(ids, v)) };
  if (part instanceof model.Staff)
    return { u, k: "staff", p, c: part.bars.map((b) => toNode(ids, b)) };
  if (part instanceof model.Track)
    return { u, k: "track", p, c: part.staves.map((s) => toNode(ids, s)) };
  return { u, k: "mbar", p, c: [] };
}

/** The ids of the bars `targets` belong to. */
function touchedBars(ids: IdRegistry, targets: Iterable<object>): Set<string> {
  const touched = new Set<string>();
  for (const target of targets) {
    let bar: Bar | undefined;
    if (target instanceof model.Bar) bar = target;
    else if (target instanceof model.Voice) bar = target.bar;
    else if (target instanceof model.Beat) bar = target.voice?.bar;
    else if (target instanceof model.Note) bar = target.beat?.voice?.bar;
    const uid = bar && ids.uid(bar);
    if (uid) touched.add(uid);
  }
  return touched;
}

/** Writes the structure of the score down, and the content of the bars in `wanted`. */
export function capture(ids: IdRegistry, score: Score, wanted: ReadonlySet<string>): State {
  const state: State = {
    tracks: [],
    staves: new Map(),
    masterBars: [],
    bars: new Map(),
    meta: new Map(),
    content: new Map(),
  };
  for (const masterBar of score.masterBars) {
    const uid = uidOf(ids, masterBar);
    state.masterBars.push(uid);
    state.meta.set(uid, encodeProps(masterBar));
  }
  for (const track of score.tracks) {
    const trackId = uidOf(ids, track);
    state.tracks.push(trackId);
    state.meta.set(trackId, encodeProps(track));
    const staffIds: string[] = [];
    for (const staff of track.staves) {
      const staffId = uidOf(ids, staff);
      staffIds.push(staffId);
      state.meta.set(staffId, encodeProps(staff));
      const barIds: string[] = [];
      for (const bar of staff.bars) {
        const barId = uidOf(ids, bar);
        barIds.push(barId);
        if (wanted.has(barId)) state.content.set(barId, toNode(ids, bar));
      }
      state.bars.set(staffId, barIds);
    }
    state.staves.set(trackId, staffIds);
  }
  return state;
}

const same = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Whether the elements both lists share come in the same order. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  const inB = new Set(b);
  const inA = new Set(a);
  return same(
    a.filter((uid) => inB.has(uid)),
    b.filter((uid) => inA.has(uid)),
  );
}

/** Operations that turn the children `before` of a part into `after`. */
function diffList(parent: string, kind: Kind, before: Node[], after: Node[], ops: Op[]): void {
  const beforeIds = before.map((n) => n.u);
  const afterIds = after.map((n) => n.u);
  if (!sameOrder(beforeIds, afterIds)) {
    // Moved parts: the simplest correct description is to take the old ones out and put the new in.
    for (const node of before) ops.push({ t: "del", u: node.u });
    after.forEach((node, i) =>
      ops.push({
        t: "ins",
        k: kind,
        p: parent,
        a: after[i - 1]?.u ?? null,
        b: after[i + 1]?.u ?? null,
        d: node,
      }),
    );
    return;
  }
  const inAfter = new Set(afterIds);
  const inBefore = new Set(beforeIds);
  for (const node of before) if (!inAfter.has(node.u)) ops.push({ t: "del", u: node.u });
  after.forEach((node, i) => {
    if (!inBefore.has(node.u)) {
      ops.push({
        t: "ins",
        k: kind,
        p: parent,
        a: after[i - 1]?.u ?? null,
        b: after[i + 1]?.u ?? null,
        d: node,
      });
    }
  });
  const previous = new Map(before.map((node) => [node.u, node]));
  for (const node of after) {
    const old = previous.get(node.u);
    if (old) diffNode(old, node, ops);
  }
}

/** Operations that turn `before` into `after` (two writings of the same part). */
function diffNode(before: Node, after: Node, ops: Op[]): void {
  const set = changedProps(before.p, after.p);
  if (set) ops.push({ t: "set", u: after.u, d: set });
  if (after.k === "note" || !after.c || !before.c) return;
  diffList(after.u, CHILD_KIND[after.k as keyof typeof CHILD_KIND], before.c, after.c, ops);
}

/** A bar line with its bars, from a captured state; null when a bar's content was not captured. */
function barLineNode(state: State, uid: string): Node | null {
  const index = state.masterBars.indexOf(uid);
  const bars: Node[] = [];
  for (const [staffId, barIds] of state.bars) {
    const barId = barIds[index];
    const bar = barId === undefined ? undefined : state.content.get(barId);
    if (!bar) return null;
    bars.push({ ...bar, x: staffId });
  }
  return { u: uid, k: "mbar", p: state.meta.get(uid) ?? {}, c: bars };
}

/** A track with its staves and bars, from a captured state; null when a bar was not captured. */
function trackNode(state: State, uid: string): Node | null {
  const staves: Node[] = [];
  for (const staffId of state.staves.get(uid) ?? []) {
    const bars: Node[] = [];
    for (const barId of state.bars.get(staffId) ?? []) {
      const bar = state.content.get(barId);
      if (!bar) return null;
      bars.push(bar);
    }
    staves.push({ u: staffId, k: "staff", p: state.meta.get(staffId) ?? {}, c: bars });
  }
  return { u: uid, k: "track", p: state.meta.get(uid) ?? {}, c: staves };
}

/** The operations that turn `before` into `after`, or a single `reset` when that is not possible. */
export function diff(before: State, after: State): Op[] {
  const ops: Op[] = [];
  const reset: Op[] = [{ t: "reset" }];
  const tracksChanged = !same(before.tracks, after.tracks);
  const barsChanged = !same(before.masterBars, after.masterBars);
  if (tracksChanged && barsChanged) return reset;
  if (!sameOrder(before.tracks, after.tracks) || !sameOrder(before.masterBars, after.masterBars)) {
    return reset;
  }
  for (const track of after.tracks) {
    const old = before.staves.get(track);
    if (old && !same(old, after.staves.get(track) ?? [])) return reset;
  }

  if (tracksChanged) {
    const inAfter = new Set(after.tracks);
    const inBefore = new Set(before.tracks);
    for (const uid of before.tracks) if (!inAfter.has(uid)) ops.push({ t: "del", u: uid });
    for (const [i, uid] of after.tracks.entries()) {
      if (inBefore.has(uid)) continue;
      const node = trackNode(after, uid);
      if (!node) return reset;
      ops.push({
        t: "ins",
        k: "track",
        p: null,
        a: after.tracks[i - 1] ?? null,
        b: after.tracks[i + 1] ?? null,
        d: node,
      });
    }
  }
  if (barsChanged) {
    const inAfter = new Set(after.masterBars);
    const inBefore = new Set(before.masterBars);
    for (const uid of before.masterBars) if (!inAfter.has(uid)) ops.push({ t: "del", u: uid });
    for (const [i, uid] of after.masterBars.entries()) {
      if (inBefore.has(uid)) continue;
      const node = barLineNode(after, uid);
      if (!node) return reset;
      ops.push({
        t: "ins",
        k: "mbar",
        p: null,
        a: after.masterBars[i - 1] ?? null,
        b: after.masterBars[i + 1] ?? null,
        d: node,
      });
    }
  }

  // Properties of the tracks, staves and bar lines that stayed.
  for (const [uid, props] of after.meta) {
    const old = before.meta.get(uid);
    const set = old && changedProps(old, props);
    if (set) ops.push({ t: "set", u: uid, d: set });
  }

  // Content of the bars that stayed (a bar is the cell where a bar line and a staff meet).
  const survivingLines = new Set(after.masterBars.filter((uid) => before.masterBars.includes(uid)));
  const survivingStaves = new Set(
    after.tracks
      .filter((track) => before.tracks.includes(track))
      .flatMap((track) => after.staves.get(track) ?? []),
  );
  for (const [barId, bar] of after.content) {
    const split = barId.indexOf(":");
    if (
      !survivingLines.has(barId.slice(0, split)) ||
      !survivingStaves.has(barId.slice(split + 1))
    ) {
      continue;
    }
    // A bar the edit did not declare has nothing to compare with: it did not change.
    const old = before.content.get(barId);
    if (old) diffNode(old, bar, ops);
  }
  return ops;
}

/** Records edits as operations. */
export class Recorder {
  readonly ids: IdRegistry;
  private readonly score: () => Score;

  constructor(ids: IdRegistry, score: () => Score) {
    this.ids = ids;
    this.score = score;
  }

  /** Call before the edit, with the objects it will change. */
  begin(targets: Iterable<object>): State {
    return capture(this.ids, this.score(), touchedBars(this.ids, targets));
  }

  /** Call after the edit, with the same targets: the operations it made and the ones that undo it. */
  end(before: State, targets: Iterable<object>): Edit {
    this.ids.sync(this.score());
    // Bars that did not exist before come with their parts, whether the edit declared them or not.
    const known = new Set([...before.bars.values()].flat());
    const created: string[] = [];
    for (const track of this.score().tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          const uid = this.ids.uid(bar);
          if (uid && !known.has(uid)) created.push(uid);
        }
      }
    }
    const wanted = new Set([
      ...touchedBars(this.ids, targets),
      ...before.content.keys(),
      ...created,
    ]);
    const after = capture(this.ids, this.score(), wanted);
    return { ops: diff(before, after), inverse: diff(after, before) };
  }
}
