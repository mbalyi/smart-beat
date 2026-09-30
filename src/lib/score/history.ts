/**
 * Unlimited undo and redo for score edits. Each entry holds snapshots of the
 * objects an edit touched, before and after (see {@link Snapshot}), plus
 * whatever else the caller needs back, such as where the cursor was.
 */
import { Snapshot } from "@/lib/score/snapshot";

export interface HistoryEntry<Extra> {
  /** What the edit did, for the menu: "Undo Add note". */
  label: string;
  before: Snapshot;
  after: Snapshot;
  /** State to return to on undo (`before`) and redo (`after`). */
  extra: { before: Extra; after: Extra };
}

export class History<Extra> {
  private done: HistoryEntry<Extra>[] = [];
  private undone: HistoryEntry<Extra>[] = [];

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get undoLabel(): string | null {
    return this.done.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone.at(-1)?.label ?? null;
  }

  /** The most recent edit that has not been undone, or null at the start. Identifies a state. */
  get top(): HistoryEntry<Extra> | null {
    return this.done.at(-1) ?? null;
  }

  /** Number of edits that can be undone. */
  get depth(): number {
    return this.done.length;
  }

  /**
   * Runs `apply`, recording `targets()` before and after it. `targets` is
   * called twice, so objects the edit creates are recorded too. If `apply`
   * throws, the model is rolled back and nothing is recorded.
   */
  record(
    label: string,
    targets: () => Iterable<object>,
    apply: () => void,
    extra: { before: Extra; after: () => Extra },
  ): void {
    const before = Snapshot.of(targets());
    try {
      apply();
    } catch (error) {
      before.restore();
      throw error;
    }
    const after = Snapshot.of(targets());
    this.done.push({ label, before, after, extra: { before: extra.before, after: extra.after() } });
    this.undone = [];
  }

  /** Reverts the last edit. Returns it (for its label and extra state), or null. */
  undo(): HistoryEntry<Extra> | null {
    const entry = this.done.pop();
    if (!entry) return null;
    entry.before.restore();
    this.undone.push(entry);
    return entry;
  }

  /** Re-applies the last undone edit, or returns null. */
  redo(): HistoryEntry<Extra> | null {
    const entry = this.undone.pop();
    if (!entry) return null;
    entry.after.restore();
    this.done.push(entry);
    return entry;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }
}
