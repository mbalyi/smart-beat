/**
 * One player's side of shared editing: turns the editor's edits into operations to send, applies
 * the operations that arrive, and keeps an undo history of this player's own edits only.
 *
 * Operations travel through the host, which puts them in one order and sends them to everyone,
 * including back to the player who made them (the echo). Players apply every operation that
 * reaches them in that order; their own edits were already applied when they made them, and
 * their echo puts the shared order back in place if someone else's edit arrived in between.
 */
import type { Beat, Score, Track } from "@/lib/score/model";
import { refinish } from "@/lib/score/model";
import { applyOps, type ApplyResult } from "@/lib/score/ops/apply";
import { Recorder, type State } from "@/lib/score/ops/diff";
import { IdRegistry } from "@/lib/score/ops/ids";
import type { Edit, Op } from "@/lib/score/ops/types";
import type { EditObserver, HistoryExtra, ScoreEditor } from "@/lib/score/editor";

interface Entry {
  label: string;
  edit: Edit;
  view: { before: HistoryExtra; after: HistoryExtra };
}

export interface EditSyncIo {
  /** Sends one edit's operations to the host (the host: to every guest). False: they cannot be sent. */
  send(ops: Op[]): boolean | void;
  /** An edit that cannot be described as operations: the host sends the whole tab again, a guest asks for it. */
  reset(): void;
}

/** Operations that take an edit back cannot always be described (see `reset` in diff.ts). */
const describable = (ops: readonly Op[]) => ops.length > 0 && !ops.some((op) => op.t === "reset");

export class EditSync implements EditObserver {
  readonly ids: IdRegistry;
  private readonly recorder: Recorder;
  private undone: Entry[] = [];
  private redone: Entry[] = [];
  /** Own edits sent and not yet echoed back: resent after a reconnect. */
  private unacked: Op[][] = [];
  /** Another player's operations were applied since the oldest unacked edit was sent. */
  private remoteSeen = false;

  private readonly editor: ScoreEditor;
  private readonly io: EditSyncIo;
  private readonly host: boolean;

  constructor(
    editor: ScoreEditor,
    io: EditSyncIo,
    peer: string,
    /** The ids this score's parts have: shared by everyone who opened the same file. */
    ids?: IdRegistry,
    /** The host puts the operations in order itself: nothing of its own is echoed back. */
    host = false,
  ) {
    this.editor = editor;
    this.io = io;
    this.host = host;
    this.ids = ids ?? new IdRegistry(peer);
    if (!ids) this.ids.init(editor.score);
    this.recorder = new Recorder(this.ids, () => this.editor.score);
  }

  /** Starts watching the editor. */
  attach(): void {
    this.editor.observer = this;
  }

  detach(): void {
    if (this.editor.observer === this) this.editor.observer = null;
  }

  private get score(): Score {
    return this.editor.score;
  }

  // --- EditObserver ---------------------------------------------------------

  get canUndo() {
    return this.undone.length > 0;
  }

  get canRedo() {
    return this.redone.length > 0;
  }

  get undoLabel() {
    return this.undone.at(-1)?.label ?? null;
  }

  get redoLabel() {
    return this.redone.at(-1)?.label ?? null;
  }

  begin(targets: Iterable<object>): State {
    this.ids.sync(this.score);
    return this.recorder.begin(targets);
  }

  end(
    token: unknown,
    targets: Iterable<object>,
    label: string,
    view: { before: HistoryExtra; after: HistoryExtra },
  ): void {
    const edit = this.recorder.end(token as State, targets);
    if (edit.ops.length === 0) return;
    if (!describable(edit.ops)) {
      this.io.reset();
      return;
    }
    // An edit that cannot be taken back (see `reset` in diff.ts) is a barrier: older edits stay.
    if (describable(edit.inverse)) this.undone.push({ label, edit, view });
    else this.undone = [];
    this.redone = [];
    this.send(edit.ops);
  }

  undo() {
    const entry = this.undone.pop();
    if (!entry) return null;
    this.redone.push(entry);
    this.applyLocal(entry.edit.inverse);
    return { label: entry.label, view: entry.view.before };
  }

  redo() {
    const entry = this.redone.pop();
    if (!entry) return null;
    this.undone.push(entry);
    this.applyLocal(entry.edit.ops);
    return { label: entry.label, view: entry.view.after };
  }

  idOf(part: Beat | Track): string | undefined {
    return this.ids.uid(part);
  }

  find(uid: string): Beat | Track | undefined {
    return this.ids.get(uid) as Beat | Track | undefined;
  }

  // --- Sending and receiving ------------------------------------------------

  private send(ops: Op[]) {
    if (this.io.send(ops) === false) return this.io.reset();
    if (!this.host) this.unacked.push(ops);
  }

  /** Applies this player's own undo or redo to the model and sends it like any edit. */
  private applyLocal(ops: Op[]) {
    applyOps(this.ids, this.score, ops);
    refinish(this.score);
    this.ids.sync(this.score);
    this.send(ops);
  }

  /** Operations sent and not yet echoed (to send again after a reconnect). */
  pending(): Op[][] {
    return this.unacked.map((ops) => [...ops]);
  }

  /**
   * Operations from the host: another player's, or the echo of this player's own. Returns
   * `reset` when the tab must be taken again.
   */
  receive(ops: readonly Op[], echo: boolean): ApplyResult | "skipped" {
    if (echo && !this.host) {
      this.unacked.shift();
      const skip = !this.remoteSeen;
      if (this.unacked.length === 0) this.remoteSeen = false;
      // Nobody else's edit came in between: the model already is what the echo says.
      if (skip) return "skipped";
    } else if (this.unacked.length > 0) {
      this.remoteSeen = true;
    }
    let result: ApplyResult = "applied";
    this.editor.applyRemote(() => {
      result = applyOps(this.ids, this.score, ops);
      refinish(this.score);
      this.ids.sync(this.score);
    });
    return result;
  }

  /** The score was replaced (a fresh copy of the tab): forget history that no longer applies. */
  clearHistory(): void {
    this.undone = [];
    this.redone = [];
    this.unacked = [];
    this.remoteSeen = false;
  }
}
