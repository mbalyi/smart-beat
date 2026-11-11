/**
 * Practice together: editing the tab together (#216). Everyone in the session edits the same tab
 * at the same time, and every change shows up on every computer within a moment.
 *
 * Edits travel as operations (see score/ops). A guest sends its operations to the host; the host
 * applies them, numbers them (`seq`) and sends them to every guest, the sender included. All
 * computers apply the operations in the host's order, which is how they end up with the same
 * tab. This file is the two ends of that: {@link HostEditing} and {@link GuestEditing}. They talk
 * through small interfaces so they need no network or session in tests.
 *
 * A guest that has just got the tab (as a file) says which edit the file is from (`since`); the
 * host answers with the ids that differ from the ones the file gives, the edits since, and then
 * `live`. A guest that was away says the last edit it saw and gets what it missed.
 */
import {
  MAX_FRAME_CHARS,
  type EditBody,
  type EditOp,
  type Presence,
} from "@/lib/practice-together/protocol";
import type { RoomEditHooks } from "@/lib/practice-together/host-room";
import type { ScoreEditor } from "@/lib/score/editor";
import { EditSync } from "@/lib/score/ops/collab";
import { explode } from "@/lib/score/ops/explode";
import { validOps } from "@/lib/score/ops/validate";
import type { Beat, Track } from "@/lib/score/model";
import type { Op } from "@/lib/score/ops/types";

/** Edits kept for guests that come late or come back. */
export const LOG_LIMIT = 400;
/** Tabs written for guests that are still receiving them (each has its own id list). */
const SNAPSHOT_LIMIT = 4;
/** The most ids sent in one message. */
const PAIRS_PER_MESSAGE = 200;
/** A cursor is sent at most this often. */
export const PRESENCE_MS = 100;
/** Operations in one frame stay below this many characters. */
const FRAME_BUDGET = Math.floor(MAX_FRAME_CHARS * 0.7);

/** Splits a batch of operations into frames that fit; null when one operation alone is too big. */
export function splitOps(batch: readonly EditOp[]): EditOp[][] | null {
  const parts: EditOp[][] = [];
  let current: EditOp[] = [];
  let size = 0;
  // A big insert (pasted bars) is cut into small ones first.
  const ops = batch.flatMap((op) =>
    JSON.stringify(op).length > FRAME_BUDGET ? (explode(op as Op) as EditOp[]) : [op],
  );
  for (const op of ops) {
    const length = JSON.stringify(op).length + 1;
    if (length > FRAME_BUDGET) return null;
    if (size + length > FRAME_BUDGET && current.length > 0) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(op);
    size += length;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** The most operations held while the parts of one batch arrive. */
const MAX_PENDING_OPS = 20_000;

/** What `Reassembler.add` found. */
type Reassembled =
  /** The whole batch (a batch that came in one piece, or its last piece). */
  | { status: "done"; ops: EditOp[] }
  /** More pieces are on their way. */
  | { status: "more" }
  /** A piece is missing or out of order, or too much arrived: the batch is dropped. */
  | { status: "broken" };

/** Puts the parts of a batch back together as they arrive (they follow each other, in order). */
class Reassembler {
  private parts: EditOp[] = [];
  /** The index of the piece expected next; -1 when no batch is being received. */
  private next = -1;
  private total = 0;

  add(ops: EditOp[], part: [number, number] | undefined): Reassembled {
    if (!part || part[1] <= 1) {
      // A single piece in the middle of a batch means pieces were lost.
      const lost = this.next !== -1;
      this.reset();
      return lost ? { status: "broken" } : { status: "done", ops };
    }
    const [index, total] = part;
    if (index >= total || (index === 0 ? false : index !== this.next || total !== this.total)) {
      this.reset();
      return { status: "broken" };
    }
    if (index === 0) {
      this.parts = [];
      this.total = total;
    }
    this.parts.push(...ops);
    if (this.parts.length > MAX_PENDING_OPS) {
      this.reset();
      return { status: "broken" };
    }
    if (index < total - 1) {
      this.next = index + 1;
      return { status: "more" };
    }
    const whole = this.parts;
    this.reset();
    return { status: "done", ops: whole };
  }

  reset() {
    this.parts = [];
    this.next = -1;
    this.total = 0;
  }
}

/** One player, as the others see them: a name, a colour and where the cursor is. */
export interface RemotePlayer {
  id: string;
  name: string;
  hue: number;
  cur: Presence | null;
}

/** A hue (degrees) for a player, the same on every computer. */
export function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash * 137) % 360;
}

/** Where the cursor and selection of an editor are, as ids. */
export function presenceOf(editor: ScoreEditor, sync: EditSync): Presence | null {
  const beat = editor.cursorBeat();
  const trackId = sync.idOf(editor.track);
  const beatId = beat && sync.idOf(beat);
  if (!beatId || !trackId) return null;
  // Only a range the player selected on purpose: one an edit, paste or undo left behind is not
  // shown, so a player standing on one note is marked on that note only.
  const range = editor.rangeSelected ? editor.selectedBeatList() : [];
  const first = range[0] && sync.idOf(range[0]);
  const last = range.at(-1) && sync.idOf(range.at(-1)!);
  return {
    track: trackId,
    beat: beatId,
    ...(first && last && range.length > 1 ? { sel: [first, last] as [string, string] } : {}),
    ...(editor.kind === "stringed" ? { string: editor.cursor.string } : {}),
    ...(editor.kind === "drums" && editor.cursor.line !== null ? { line: editor.cursor.line } : {}),
  };
}

/** Where a remote cursor sits now, as positions in the editor's own track. */
export function locate(
  sync: EditSync,
  cur: Presence,
): { track: Track; beat: Beat; sel?: [Beat, Beat]; string?: number; line?: number } | null {
  const track = sync.find(cur.track) as Track | undefined;
  const beat = sync.find(cur.beat) as Beat | undefined;
  if (!track || !beat?.voice?.bar) return null;
  const first = cur.sel && (sync.find(cur.sel[0]) as Beat | undefined);
  const last = cur.sel && (sync.find(cur.sel[1]) as Beat | undefined);
  return {
    track,
    beat,
    ...(first?.voice?.bar && last?.voice?.bar ? { sel: [first, last] as [Beat, Beat] } : {}),
    ...(cur.string === undefined ? {} : { string: cur.string }),
    ...(cur.line === undefined ? {} : { line: cur.line }),
  };
}

// ----- the host ----------------------------------------------------------------------------

/** What the host's room offers shared editing. */
export interface HostLink {
  seats(): { id: string; name: string }[];
  send(seat: string, body: EditBody): void;
  setLive(seat: string, on: boolean): void;
  shareTab(seat: string): void;
}

interface Seat {
  name: string;
  live: boolean;
  canEdit: boolean;
  incoming: Reassembler;
}

export interface HostEditingOptions {
  /** The host's name, shown on its cursor. */
  name?: string;
  /** The fingerprint key of the host's tab as it is now (for a guest that already has the tab). */
  currentKey(): Promise<string>;
  /** Something about the players changed (who edits, who may). */
  changed?(): void;
}

export class HostEditing implements RoomEditHooks {
  readonly sync: EditSync;
  /** The number of the last edit, in the host's order. */
  seq = 0;
  private log: { seq: number; from: string; ops: EditOp[] }[] = [];
  private readonly snapshots = new Map<number, [string, string][]>();
  private readonly seats = new Map<string, Seat>();
  private canEditByDefault = true;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPresence: Presence | null = null;
  private readonly remote = new Map<string, RemotePlayer>();
  private readonly listeners = new Set<() => void>();
  private ended = false;

  private readonly editor: ScoreEditor;
  private readonly link: HostLink;
  private readonly options: HostEditingOptions;

  constructor(editor: ScoreEditor, link: HostLink, options: HostEditingOptions) {
    this.editor = editor;
    this.link = link;
    this.options = options;
    this.sync = new EditSync(
      editor,
      {
        send: (ops) => this.publish("host", ops as EditOp[]),
        reset: () => this.resyncAll(),
      },
      "host",
      undefined,
      true,
    );
    this.sync.attach();
    // Guests already in the session (this tab just took the session over) start over: they get
    // their rights again and say what they have once they have this tab.
    for (const { id } of link.seats()) this.welcomed(id);
  }

  /** Stops watching the editor. */
  end(): void {
    this.ended = true;
    clearTimeout(this.presenceTimer);
    this.sync.detach();
    for (const { id } of this.link.seats()) this.link.setLive(id, false);
    // A guest being served right now must not be told it is live by an instance that has ended.
    this.seats.clear();
  }

  /** Whether guests may edit (on unless the host turned it off). */
  get guestsCanEdit(): boolean {
    return this.canEditByDefault;
  }

  /** The host turns editing for guests on or off. A guest that may not edit follows the host's tab. */
  setGuestsCanEdit(on: boolean): void {
    if (on === this.canEditByDefault) return;
    this.canEditByDefault = on;
    for (const [id, seat] of this.seats) {
      seat.canEdit = on;
      this.link.send(id, { k: "rights", canEdit: on });
    }
    this.options.changed?.();
  }

  /** The other players' cursors. */
  get players(): readonly RemotePlayer[] {
    return [...this.remote.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }

  /** The tab is about to be written as a file: the edit number it is from, and its ids. */
  snapshot(): { seq: number } {
    this.snapshots.set(this.seq, this.sync.ids.differences(this.editor.score));
    for (const old of [...this.snapshots.keys()].slice(0, -SNAPSHOT_LIMIT)) {
      this.snapshots.delete(old);
    }
    return { seq: this.seq };
  }

  // ----- from the guests ----

  welcomed(id: string): void {
    const seat: Seat = {
      name: this.link.seats().find((s) => s.id === id)?.name ?? "A player",
      live: false,
      canEdit: this.canEditByDefault,
      incoming: new Reassembler(),
    };
    this.seats.set(id, seat);
    this.link.setLive(id, false);
    this.link.send(id, { k: "rights", canEdit: seat.canEdit, hello: true });
    this.options.changed?.();
  }

  left(id: string): void {
    if (!this.seats.delete(id)) return;
    if (this.remote.delete(id)) this.notify();
    this.broadcastPresence({ k: "presence", cur: null, who: id }, id);
    this.options.changed?.();
  }

  receive(id: string, body: EditBody): void {
    const seat = this.seats.get(id);
    if (!seat || this.ended) return;
    switch (body.k) {
      case "since":
        return void this.serve(id, seat, body);
      case "ops":
        return this.onOps(id, seat, body);
      case "resync":
        return this.resyncSeat(id, seat);
      case "presence":
        if (!seat.live || body.cur === null) return this.onPresence(id, seat, null);
        return this.onPresence(id, seat, body.cur);
    }
  }

  private onOps(id: string, seat: Seat, body: Extract<EditBody, { k: "ops" }>) {
    // A guest that may not edit (the host turned it off, or it has not got the tab yet) is told,
    // and what it already did is undone for it: it gets the tab again.
    if (!seat.live || !seat.canEdit) {
      seat.incoming.reset();
      this.link.send(id, { k: "rights", canEdit: seat.canEdit });
      return this.resyncSeat(id, seat);
    }
    const found = seat.incoming.add(body.ops, body.part);
    if (found.status === "more") return;
    if (found.status === "broken") return this.resyncSeat(id, seat);
    // What a guest sends is checked before it touches the host's tab: a modified app could send
    // anything, and an edit that fails half way would leave the host's tab changed and unshared.
    const ops = validOps(found.ops);
    if (!ops) return this.resyncSeat(id, seat);
    let result: ReturnType<EditSync["receive"]>;
    try {
      result = this.sync.receive(ops, false);
    } catch {
      return this.resyncAll();
    }
    if (result === "reset") return this.resyncAll();
    this.publish(id, ops as EditOp[]);
  }

  private onPresence(id: string, seat: Seat, cur: Presence | null) {
    const player: RemotePlayer = { id, name: seat.name, hue: hueOf(id), cur };
    if (cur) this.remote.set(id, player);
    else this.remote.delete(id);
    this.notify();
    this.broadcastPresence({ k: "presence", cur, who: id, name: seat.name, hue: player.hue }, id);
  }

  // ----- to the guests ----

  /** An edit in the host's order goes to every guest that has the tab (the sender gets it back). */
  private publish(from: string, ops: EditOp[]): boolean {
    this.seq += 1;
    this.log.push({ seq: this.seq, from, ops });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    const parts = splitOps(ops);
    if (!parts) {
      // One operation is bigger than a frame: everyone takes the tab again.
      this.resyncAll();
      return false;
    }
    for (const [id, seat] of this.seats) {
      if (seat.live) this.sendOps(id, from, this.seq, parts);
    }
    return true;
  }

  private sendOps(id: string, from: string, seq: number, parts: EditOp[][]) {
    parts.forEach((ops, i) =>
      this.link.send(id, {
        k: "ops",
        ops,
        from,
        seq,
        ...(parts.length > 1 && { part: [i, parts.length] as [number, number] }),
      }),
    );
  }

  /** The guest's tab is old or lost: it gets the whole tab again. */
  private resyncSeat(id: string, seat: Seat) {
    seat.live = false;
    this.link.setLive(id, false);
    this.link.shareTab(id);
  }

  private resyncAll() {
    for (const [id, seat] of this.seats) this.resyncSeat(id, seat);
  }

  /** Whether every edit after `seq` is still in the log. */
  private covers(seq: number): boolean {
    if (seq === this.seq) return true;
    return this.log.length > 0 && this.log[0]!.seq <= seq + 1 && seq <= this.seq;
  }

  /** A guest has the tab: it gets the ids, what happened since, and then goes live. */
  private async serve(id: string, seat: Seat, since: Extract<EditBody, { k: "since" }>) {
    let pairs: [string, string][] | undefined;
    let from = since.seq;
    if (since.resume) {
      pairs = [];
    } else if (this.snapshots.has(since.seq)) {
      pairs = this.snapshots.get(since.seq);
    } else if (since.key !== undefined) {
      // A guest that already had this tab (no file was sent): it must be the tab as it is now.
      const seqNow = this.seq;
      const key = await this.options.currentKey();
      if (!this.ended && key === since.key && seqNow === this.seq && this.seats.get(id) === seat) {
        pairs = this.sync.ids.differences(this.editor.score);
        from = this.seq;
      }
    }
    // This instance ended (the host moved to another tab) while the guest was being served: the
    // new instance serves it.
    if (this.ended || this.seats.get(id) !== seat) return;
    if (!pairs || !this.covers(from)) return this.resyncSeat(id, seat);
    for (let i = 0; i < pairs.length; i += PAIRS_PER_MESSAGE) {
      this.link.send(id, {
        k: "uids",
        pairs: pairs.slice(i, i + PAIRS_PER_MESSAGE),
        seq: this.seq,
      });
    }
    for (const entry of this.log) {
      if (entry.seq <= from) continue;
      const parts = splitOps(entry.ops);
      if (!parts) return this.resyncSeat(id, seat);
      this.sendOps(id, entry.from, entry.seq, parts);
    }
    seat.live = true;
    this.link.setLive(id, true);
    this.link.send(id, { k: "live", seq: this.seq });
    this.options.changed?.();
    // The new player sees where the others are.
    for (const player of this.remote.values()) {
      this.link.send(id, {
        k: "presence",
        cur: player.cur,
        who: player.id,
        name: player.name,
        hue: player.hue,
      });
    }
    if (this.lastPresence) {
      this.link.send(id, {
        k: "presence",
        cur: this.lastPresence,
        who: "host",
        name: this.options.name ?? "Host",
        hue: hueOf("host"),
      });
    }
  }

  private broadcastPresence(body: EditBody, except?: string) {
    for (const [id, seat] of this.seats) if (seat.live && id !== except) this.link.send(id, body);
  }

  /** The host's own cursor moved (call on every change; it is sent a few times a second). */
  setPresence(): void {
    if (this.presenceTimer || this.ended) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      if (this.ended) return;
      this.lastPresence = presenceOf(this.editor, this.sync);
      this.broadcastPresence({
        k: "presence",
        cur: this.lastPresence,
        who: "host",
        name: this.options.name ?? "Host",
        hue: hueOf("host"),
      });
    }, PRESENCE_MS);
  }

  /** Guests that edit along: for the dialog. */
  editors(): { id: string; name: string; live: boolean; canEdit: boolean }[] {
    return [...this.seats].map(([id, seat]) => ({
      id,
      name: seat.name,
      live: seat.live,
      canEdit: seat.canEdit,
    }));
  }
}

// ----- a guest -----------------------------------------------------------------------------

export interface GuestLink {
  send(body: EditBody): void;
}

export interface GuestEditingOptions {
  /** This guest's own id (the one the host knows it by). */
  guest: string;
  /** The host's edit number the tab file is from; -1: the guest already had this tab. */
  seq: number;
  /** The fingerprint key of the tab the guest has (said with `since` when `seq` is -1). */
  key: string;
  /** Rights or the live state changed. */
  changed?(): void;
}

export class GuestEditing {
  readonly sync: EditSync;
  private _live = false;
  private _canEdit = false;
  /** The host's first word is its rights: that is the cue to say what this guest has. */
  private awaiting = true;
  /** The line dropped and this guest asked for what it missed: edits ahead of the gap wait for it. */
  private resuming = false;
  private lastSeq: number;
  private readonly incoming = new Reassembler();
  private sentId = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly remote = new Map<string, RemotePlayer>();
  private readonly listeners = new Set<() => void>();
  private ended = false;

  private readonly editor: ScoreEditor;
  private readonly link: GuestLink;
  private readonly options: GuestEditingOptions;

  constructor(editor: ScoreEditor, link: GuestLink, options: GuestEditingOptions) {
    this.editor = editor;
    this.link = link;
    this.options = options;
    this.lastSeq = options.seq;
    this.sync = new EditSync(
      editor,
      {
        send: (ops) => this.sendOps(ops as EditOp[]),
        reset: () => this.link.send({ k: "resync" }),
      },
      options.guest,
    );
  }

  /**
   * Starts listening. The host's rights message (it sends one when a guest is let in or comes
   * back) is answered with what this guest has, and the host replies with what it lacks.
   */
  start(): void {
    this.awaiting = true;
  }

  end(): void {
    this.ended = true;
    clearTimeout(this.presenceTimer);
    this.sync.detach();
  }

  /** Whether this guest is up to date and may edit. */
  get editable(): boolean {
    return this._live && this._canEdit;
  }

  get live(): boolean {
    return this._live;
  }

  get canEdit(): boolean {
    return this._canEdit;
  }

  get players(): readonly RemotePlayer[] {
    return [...this.remote.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.options.changed?.();
    for (const listener of [...this.listeners]) listener();
  }

  private sendOps(ops: EditOp[]): boolean {
    const parts = splitOps(ops);
    if (!parts) return false;
    this.sentId += 1;
    parts.forEach((part, i) =>
      this.link.send({
        k: "ops",
        ops: part,
        ...(parts.length > 1 && { part: [i, parts.length] as [number, number] }),
      }),
    );
    return true;
  }

  receive(body: EditBody): void {
    if (this.ended) return;
    switch (body.k) {
      case "rights": {
        this._canEdit = body.canEdit;
        if (this.awaiting) {
          this.awaiting = false;
          this.link.send({ k: "since", seq: this.options.seq, key: this.options.key });
        } else if (this._live && body.hello) {
          // The host says hello again when this guest comes back: what was missed is asked for.
          this.comeBack();
        }
        this.notify();
        return;
      }
      case "uids":
        this.sync.ids.rename(this.editor.score, body.pairs);
        return;
      case "ops": {
        const found = this.incoming.add(body.ops, body.part);
        if (found.status === "more") return;
        // A piece went missing: ask for what was missed.
        if (found.status === "broken") return this.comeBack();
        // The host numbers its edits one by one: one already applied is skipped, and a gap means
        // a frame was lost, so what came after it waits until the gap is filled.
        if (body.seq !== undefined) {
          if (body.seq <= this.lastSeq) return;
          if (body.seq > this.lastSeq + 1) return this.comeBack();
          this.lastSeq = body.seq;
        }
        // The host's order is final: the echo of this guest's own edit puts it back in place.
        try {
          const result = this.sync.receive(found.ops as Op[], body.from === this.options.guest);
          if (result === "reset") this.link.send({ k: "resync" });
        } catch {
          // A batch that does not fit this tab is refused before anything is written: ask for the tab.
          this.link.send({ k: "resync" });
        }
        return;
      }
      case "live":
        this.lastSeq = body.seq;
        this.resuming = false;
        if (!this._live) {
          this.sync.attach();
          this._live = true;
          // Edits made before the connection dropped and never echoed are sent again.
          for (const batch of this.sync.pending()) this.sendOps(batch as EditOp[]);
        }
        this.notify();
        return;
      case "presence": {
        if (!body.who) return;
        if (body.cur) {
          this.remote.set(body.who, {
            id: body.who,
            name: body.name ?? "A player",
            hue: body.hue ?? hueOf(body.who),
            cur: body.cur,
          });
        } else this.remote.delete(body.who);
        this.notify();
        return;
      }
    }
  }

  /** The line dropped and came back, or an edit went missing: ask for what was missed. */
  private comeBack() {
    // Asked already: the answer replays everything after the gap, once.
    if (this.resuming) return;
    this.resuming = true;
    this._live = false;
    this.incoming.reset();
    this.link.send({ k: "since", seq: this.lastSeq, resume: true });
    this.notify();
  }

  /** This guest's own cursor moved (call on every change; it is sent a few times a second). */
  setPresence(): void {
    if (this.presenceTimer || this.ended || !this._live) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      if (this.ended) return;
      this.link.send({ k: "presence", cur: presenceOf(this.editor, this.sync) });
    }, PRESENCE_MS);
  }
}

/** Keeps what the other end said about editing until the editing that listens is ready. */
export class EditInbox {
  private handler: ((body: EditBody) => void) | null = null;
  private queue: EditBody[] = [];

  /** A message arrived. */
  push(body: EditBody): void {
    if (this.handler) return this.handler(body);
    this.queue.push(body);
    if (this.queue.length > 300) this.queue.shift();
  }

  /** Starts (or, with null, stops) listening; what arrived before is handed over now. */
  listen(handler: ((body: EditBody) => void) | null): void {
    this.handler = handler;
    if (!handler) return;
    for (const body of this.queue.splice(0)) handler(body);
  }

  /** Forgets what was kept (a new session starts). */
  clear(): void {
    this.queue = [];
  }
}
