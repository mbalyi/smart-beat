/**
 * Stable ids for the parts of a score.
 *
 * alphaTab's objects only know their position, and positions move when bars are inserted. The
 * registry gives every track, staff, bar line, beat and note an id that stays with it. Two
 * players who open the same file derive the same ids from the positions in it
 * ({@link IdRegistry.init}), so nothing has to be sent. Parts a player creates later get an id
 * from that player's own counter.
 *
 * Bars and voices have no identity of their own: a bar is the cell where a bar line and a staff
 * meet (its id is both ids), a voice is a slot in a bar (its id is the bar's plus the number).
 */
import { model } from "@coderline/alphatab";

import type { Score } from "@/lib/score/model";

export type Part =
  model.Track | model.Staff | model.MasterBar | model.Bar | model.Voice | model.Beat | model.Note;

/** Every part inside `part`, itself included. */
export function* subtree(part: Part): Generator<Part> {
  yield part;
  if (part instanceof model.Track) {
    for (const staff of part.staves) yield* subtree(staff);
  } else if (part instanceof model.Staff) {
    for (const bar of part.bars) yield* subtree(bar);
  } else if (part instanceof model.Bar) {
    for (const voice of part.voices) yield* subtree(voice);
  } else if (part instanceof model.Voice) {
    for (const beat of part.beats) yield* subtree(beat);
  } else if (part instanceof model.Beat) {
    yield* part.notes;
  }
}

export class IdRegistry {
  private readonly ids = new WeakMap<object, string>();
  private byId = new Map<string, Part>();
  private counter = 0;
  private readonly nonce: string;

  /** `peer` names the player: ids they create start with it. */
  constructor(peer: string, nonce = Math.random().toString(36).slice(2, 8)) {
    this.nonce = `${peer.replace(/[^a-z0-9]/gi, "")}${nonce}`;
  }

  /** Gives every part its position-derived id. Call once, right after the file was read. */
  init(score: Score): void {
    this.walk(score, true);
  }

  /** Gives parts that have no id yet (created by an edit) one, and forgets deleted parts. */
  sync(score: Score): void {
    this.walk(score, false);
  }

  uid(part: Part): string | undefined {
    return this.ids.get(part);
  }

  get(uid: string | null | undefined): Part | undefined {
    return uid == null ? undefined : this.byId.get(uid);
  }

  /** Records an id for a part that arrived inside an operation. */
  adopt(part: Part, uid: string): void {
    this.ids.set(part, uid);
    this.byId.set(uid, part);
  }

  /** Forgets a deleted part and everything inside it, so later operations on them are dropped. */
  forget(part: Part): void {
    for (const inner of subtree(part)) {
      const uid = this.ids.get(inner);
      if (uid !== undefined && this.byId.get(uid) === inner) this.byId.delete(uid);
    }
  }

  /**
   * The ids that differ from the ones a player who just read the same file would derive, as
   * `[derived, actual]` pairs. A player who joins late reads the file, derives ids, and applies
   * these to get this player's ids ({@link rename}).
   */
  differences(score: Score): [string, string][] {
    const positional = new IdRegistry("d");
    positional.init(score);
    const pairs: [string, string][] = [];
    for (const part of this.byId.values()) {
      if (part instanceof model.Bar || part instanceof model.Voice) continue;
      const derived = positional.uid(part);
      const actual = this.ids.get(part);
      if (derived !== undefined && actual !== undefined && derived !== actual) {
        pairs.push([derived, actual]);
      }
    }
    return pairs;
  }

  /** Applies the output of {@link differences} (made for the same file) to a score read from it. */
  rename(score: Score, pairs: readonly (readonly [string, string])[]): void {
    const parts = pairs.map(([derived, actual]) => [this.byId.get(derived), actual] as const);
    for (const [part, actual] of parts) if (part) this.ids.set(part, actual);
    this.walk(score, false);
  }

  private fresh(): string {
    return `${this.nonce}-${this.counter++}`;
  }

  private walk(score: Score, positional: boolean): void {
    const byId = new Map<string, Part>();
    /** Parts with an id of their own keep it; new ones get a derived (first read) or a counter id. */
    const own = (part: Part, derived: string): string => {
      const uid = this.ids.get(part) ?? (positional ? derived : this.fresh());
      this.ids.set(part, uid);
      byId.set(uid, part);
      return uid;
    };
    /** Bars and voices always take the id of the slot they sit in. */
    const slot = (part: Part, uid: string): string => {
      this.ids.set(part, uid);
      byId.set(uid, part);
      return uid;
    };
    const masterBarIds = score.masterBars.map((masterBar, m) => own(masterBar, `m${m}`));
    score.tracks.forEach((track, t) => {
      const trackId = own(track, `t${t}`);
      track.staves.forEach((staff, s) => {
        const staffId = own(staff, `${trackId}.s${s}`);
        staff.bars.forEach((bar, b) => {
          const barId = slot(bar, `${masterBarIds[b] ?? `m${b}`}:${staffId}`);
          bar.voices.forEach((voice, v) => {
            const voiceId = slot(voice, `${barId}.v${v}`);
            voice.beats.forEach((beat, i) => {
              const beatId = own(beat, `${voiceId}.b${i}`);
              beat.notes.forEach((note, n) => own(note, `${beatId}.n${n}`));
            });
          });
        });
      });
    });
    this.byId = byId;
  }
}
