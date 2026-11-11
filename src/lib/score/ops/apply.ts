/**
 * Applies operations to a score. The caller refinishes the model afterwards (the editor does, in
 * `changed`).
 *
 * Operations are idempotent and tolerant: one whose target is gone (a peer deleted it first) is
 * dropped, an insert of an element that already exists moves it to the place the operation names,
 * and an insert whose neighbour is gone goes to the end of the list. All players apply the same
 * operations in the host's order, so they end up with the same score.
 */
import { model } from "@coderline/alphatab";

import { assignProps, checkProps } from "@/lib/score/ops/codec";
import { kindOf, type PartKind } from "@/lib/score/ops/fields";
import { subtree, type IdRegistry, type Part } from "@/lib/score/ops/ids";
import type { Node, Op } from "@/lib/score/ops/types";
import { newBar, newVoice, placeholderBeats, type Score } from "@/lib/score/model";

export type ApplyResult = "applied" | "reset";

/** Builds the parts of a node (and their children), recording their ids. */
function build(ids: IdRegistry, node: Node): Part {
  let part: Part;
  switch (node.k) {
    case "note":
      part = new model.Note();
      break;
    case "beat": {
      const beat = new model.Beat();
      for (const child of node.c ?? []) {
        const note = build(ids, child) as model.Note;
        note.beat = beat;
        beat.notes.push(note);
      }
      part = beat;
      break;
    }
    case "voice": {
      const voice = new model.Voice();
      for (const child of node.c ?? []) {
        const beat = build(ids, child) as model.Beat;
        beat.voice = voice;
        voice.beats.push(beat);
      }
      part = voice;
      break;
    }
    case "bar": {
      const bar = new model.Bar();
      for (const child of node.c ?? []) {
        const voice = build(ids, child) as model.Voice;
        voice.bar = bar;
        bar.voices.push(voice);
      }
      part = bar;
      break;
    }
    case "staff": {
      const staff = new model.Staff();
      for (const child of node.c ?? []) {
        const bar = build(ids, child) as model.Bar;
        bar.staff = staff;
        staff.bars.push(bar);
      }
      part = staff;
      break;
    }
    case "track": {
      const track = new model.Track();
      for (const child of node.c ?? []) {
        const staff = build(ids, child) as model.Staff;
        staff.track = track;
        track.staves.push(staff);
      }
      part = track;
      break;
    }
    default:
      part = new model.MasterBar();
  }
  assignProps(part, node.p);
  ids.adopt(part, node.u);
  return part;
}

/**
 * Where an insert goes: right after the neighbour `after` (first when the operation names none).
 * When that neighbour is gone (another player deleted it), right before the neighbour `before`
 * that was behind it, and at the end when both are gone.
 */
function slotAfter<T>(
  list: T[],
  after: T | undefined,
  afterGiven: boolean,
  before?: T | undefined,
): number {
  if (!afterGiven) return 0;
  const at = after === undefined ? -1 : list.indexOf(after);
  if (at >= 0) return at + 1;
  const next = before === undefined ? -1 : list.indexOf(before);
  return next >= 0 ? next : list.length;
}

function removeFrom<T>(list: T[], item: T): number {
  const at = list.indexOf(item);
  if (at >= 0) list.splice(at, 1);
  return at;
}

/**
 * An empty bar for a staff that has none at this bar line. Every computer makes it, so its parts
 * get ids from the bar's id: an edit inside it must name the same beat on all of them.
 */
function placeholderBar(
  ids: IdRegistry,
  masterBar: model.MasterBar,
  staff: model.Staff,
  barId: string,
): model.Bar {
  const bar = newBar(staff.bars[0] ?? new model.Bar(), masterBar);
  if (bar.voices.length === 0) bar.addVoice(newVoice(placeholderBeats(masterBar, 0)));
  ids.adopt(bar, barId);
  bar.voices.forEach((voice, v) =>
    voice.beats.forEach((beat, i) => ids.adopt(beat, `${barId}.v${v}.b${i}`)),
  );
  return bar;
}

function insertBarLine(ids: IdRegistry, score: Score, op: Extract<Op, { t: "ins" }>) {
  const existing = ids.get(op.d.u);
  if (existing instanceof model.MasterBar) deleteBarLine(ids, score, existing);
  const masterBar = build(ids, op.d) as model.MasterBar;
  const anchor = ids.get(op.a);
  const at = slotAfter(
    score.masterBars,
    anchor as model.MasterBar | undefined,
    op.a !== null,
    ids.get(op.b) as model.MasterBar | undefined,
  );
  score.masterBars.splice(at, 0, masterBar);
  masterBar.score = score;
  const bars = new Map((op.d.c ?? []).map((node) => [node.x ?? "", build(ids, node) as model.Bar]));
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const staffId = ids.uid(staff) ?? "";
      const barId = `${op.d.u}:${staffId}`;
      const bar = bars.get(staffId) ?? placeholderBar(ids, masterBar, staff, barId);
      bar.staff = staff;
      staff.bars.splice(at, 0, bar);
      ids.adopt(bar, barId);
    }
  }
}

function deleteBarLine(ids: IdRegistry, score: Score, masterBar: model.MasterBar) {
  const at = removeFrom(score.masterBars, masterBar);
  if (at < 0) return;
  ids.forget(masterBar);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const [bar] = staff.bars.splice(at, 1);
      if (bar) ids.forget(bar);
    }
  }
}

function insertTrack(ids: IdRegistry, score: Score, op: Extract<Op, { t: "ins" }>) {
  const existing = ids.get(op.d.u);
  if (existing instanceof model.Track) deleteTrack(ids, score, existing);
  const track = build(ids, op.d) as model.Track;
  track.score = score;
  // Make the bars match the bar lines this player has now (others may have added or removed some).
  for (const staff of track.staves) {
    const staffId = ids.uid(staff) ?? "";
    const given = new Map(staff.bars.map((bar) => [ids.uid(bar), bar]));
    staff.bars = score.masterBars.map((masterBar) => {
      const barId = `${ids.uid(masterBar)}:${staffId}`;
      const bar = given.get(barId) ?? placeholderBar(ids, masterBar, staff, barId);
      ids.adopt(bar, barId);
      bar.staff = staff;
      return bar;
    });
  }
  const anchor = ids.get(op.a);
  score.tracks.splice(
    slotAfter(
      score.tracks,
      anchor as model.Track | undefined,
      op.a !== null,
      ids.get(op.b) as model.Track | undefined,
    ),
    0,
    track,
  );
}

function deleteTrack(ids: IdRegistry, score: Score, track: model.Track) {
  if (removeFrom(score.tracks, track) >= 0) ids.forget(track);
}

/** The kind of part each kind of node lives in. */
const PARENT_KIND: Partial<Record<PartKind, PartKind>> = {
  voice: "bar",
  beat: "voice",
  note: "beat",
};
/** The kinds a `del` removes. */
const DELETABLE: readonly PartKind[] = ["mbar", "track", "voice", "beat", "note"];

/**
 * The identities the score has while the batch is checked: what the registry holds, changed by
 * the operations before the one being looked at. An id maps to the kind of part that carries it,
 * or to nothing once the part is gone.
 */
class Identities {
  private readonly changed = new Map<string, PartKind | null>();
  /** For a node made in this batch: the ids of the nodes inside it. */
  private readonly inside = new Map<string, string[]>();

  private readonly ids: IdRegistry;
  private readonly score: Score;

  constructor(ids: IdRegistry, score: Score) {
    this.ids = ids;
    this.score = score;
  }

  kind(uid: string | null): PartKind | undefined {
    if (uid === null) return undefined;
    if (this.changed.has(uid)) return this.changed.get(uid) ?? undefined;
    return kindOf(this.ids.get(uid));
  }

  /** The part that carries `uid` goes, with everything inside it. */
  release(uid: string): void {
    if (this.changed.has(uid)) {
      for (const inner of this.inside.get(uid) ?? []) this.changed.set(inner, null);
    } else {
      for (const inner of this.heldBy(this.ids.get(uid))) {
        if (!this.changed.has(inner)) this.changed.set(inner, null);
      }
    }
    this.changed.set(uid, null);
  }

  /** Takes the ids in `node`; throws when one is already carried by a part (or twice in the node). */
  claim(node: Node): string[] {
    if (this.kind(node.u) !== undefined) throw new Error(`The id ${node.u} is already in use.`);
    this.changed.set(node.u, node.k);
    const held = (node.c ?? []).flatMap((child) => [child.u, ...this.claim(child)]);
    this.inside.set(node.u, held);
    return held;
  }

  /** The ids of the parts inside `part` (itself excluded) as the registry has them. */
  private heldBy(part: Part | undefined): string[] {
    if (!part) return [];
    const inner: Part[] = [];
    if (part instanceof model.MasterBar) {
      const at = this.score.masterBars.indexOf(part);
      for (const track of this.score.tracks) {
        for (const staff of track.staves) {
          const bar = staff.bars[at];
          if (at >= 0 && bar) inner.push(...subtree(bar));
        }
      }
    } else {
      inner.push(...subtree(part));
      inner.shift();
    }
    return inner.flatMap((item) => this.ids.uid(item) ?? []);
  }
}

/** Throws when some property in the node (or inside it) cannot be written. */
function checkNode(node: Node): void {
  checkProps(node.k, node.p);
  for (const child of node.c ?? []) checkNode(child);
}

/**
 * Throws when an operation writes something that is not a data field of its target, the wrong
 * kind of value, or gives a part an id another part already has: ids are what later operations
 * name, so each must lead to one part, and a `set` is judged by the part its id will lead to at
 * that point of the batch. A target that is not there is skipped: the operation will be dropped.
 */
function checkOps(ids: IdRegistry, score: Score, ops: readonly Op[]): void {
  const now = new Identities(ids, score);
  for (const op of ops) {
    if (op.t === "ins") {
      checkNode(op.d);
      const wanted = PARENT_KIND[op.k];
      const parent = wanted ? now.kind(op.p) : undefined;
      if (wanted && parent === undefined) continue; // no parent: dropped
      if (wanted && parent !== wanted) throw new Error(`A ${op.k} does not go into a ${parent}.`);
      const here = now.kind(op.d.u);
      if (here !== undefined && here !== op.d.k) {
        throw new Error(`The id ${op.d.u} belongs to a ${here}, not a ${op.d.k}.`);
      }
      // The same kind with the same id is the part again: it moves, taking its content along.
      if (here !== undefined) now.release(op.d.u);
      now.claim(op.d);
    } else if (op.t === "del") {
      const kind = now.kind(op.u);
      if (kind && DELETABLE.includes(kind)) now.release(op.u);
    } else if (op.t === "set") {
      const kind = now.kind(op.u);
      if (kind) checkProps(kind, op.d);
    }
  }
}

/**
 * Applies `ops`; `reset` when one says the tab must be taken again. Throws, before changing
 * anything, when an operation cannot be applied (malformed data from another computer).
 */
export function applyOps(ids: IdRegistry, score: Score, ops: readonly Op[]): ApplyResult {
  checkOps(ids, score, ops);
  for (const op of ops) {
    if (op.t === "reset") return "reset";
    if (op.t === "set") {
      const part = ids.get(op.u);
      if (part) assignProps(part, op.d);
      continue;
    }
    if (op.t === "del") {
      const part = ids.get(op.u);
      if (part instanceof model.MasterBar) deleteBarLine(ids, score, part);
      else if (part instanceof model.Track) deleteTrack(ids, score, part);
      else if (part instanceof model.Voice) {
        if (removeFrom(part.bar.voices, part) >= 0) ids.forget(part);
      } else if (part instanceof model.Beat) {
        if (removeFrom(part.voice.beats, part) >= 0) ids.forget(part);
      } else if (part instanceof model.Note) {
        if (removeFrom(part.beat.notes, part) >= 0) ids.forget(part);
      }
      continue;
    }
    if (op.k === "mbar") insertBarLine(ids, score, op);
    else if (op.k === "track") insertTrack(ids, score, op);
    else insertInner(ids, op);
  }
  keepOneBar(ids, score);
  return "applied";
}

/**
 * A song keeps at least one bar. Two players can each delete one of two bars at the same time;
 * whoever applies the second deletion finds nothing left and puts in an empty bar, the same
 * one everywhere (it has a fixed id), and takes it out again when other bars are there.
 */
function keepOneBar(ids: IdRegistry, score: Score) {
  const stand = ids.get("m-empty");
  if (stand instanceof model.MasterBar && score.masterBars.length > 1) {
    // Other bars are there now (this player saw a moment the others did not): the stand-in goes.
    deleteBarLine(ids, score, stand);
    return;
  }
  if (score.masterBars.length > 0 || score.tracks.length === 0) return;
  const masterBar = new model.MasterBar();
  masterBar.score = score;
  ids.adopt(masterBar, "m-empty");
  score.masterBars.push(masterBar);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const bar = placeholderBar(ids, masterBar, staff, `m-empty:${ids.uid(staff) ?? ""}`);
      bar.staff = staff;
      staff.bars.push(bar);
    }
  }
}

/** Inserts a voice, beat or note into its parent. */
function insertInner(ids: IdRegistry, op: Extract<Op, { t: "ins" }>) {
  const parent = ids.get(op.p);
  if (!parent) return;
  if (PARENT_KIND[op.k] !== kindOf(parent)) return;
  const existing = ids.get(op.d.u);
  if (existing) {
    // Already here (an earlier apply, or the sender's own copy): it moves to where the op says.
    if (existing instanceof model.Voice) removeFrom(existing.bar.voices, existing);
    else if (existing instanceof model.Beat) removeFrom(existing.voice.beats, existing);
    else if (existing instanceof model.Note) removeFrom(existing.beat.notes, existing);
    ids.forget(existing);
  }
  const part = build(ids, op.d);
  const anchor = ids.get(op.a);
  if (op.k === "voice" && parent instanceof model.Bar) {
    (part as model.Voice).bar = parent;
    parent.voices.splice(
      slotAfter(
        parent.voices,
        anchor as model.Voice | undefined,
        op.a !== null,
        ids.get(op.b) as model.Voice | undefined,
      ),
      0,
      part as model.Voice,
    );
  } else if (op.k === "beat" && parent instanceof model.Voice) {
    (part as model.Beat).voice = parent;
    parent.beats.splice(
      slotAfter(
        parent.beats,
        anchor as model.Beat | undefined,
        op.a !== null,
        ids.get(op.b) as model.Beat | undefined,
      ),
      0,
      part as model.Beat,
    );
  } else if (op.k === "note" && parent instanceof model.Beat) {
    (part as model.Note).beat = parent;
    parent.notes.splice(
      slotAfter(
        parent.notes,
        anchor as model.Note | undefined,
        op.a !== null,
        ids.get(op.b) as model.Note | undefined,
      ),
      0,
      part as model.Note,
    );
  }
}
