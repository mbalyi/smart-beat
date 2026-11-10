/**
 * The score editor's clipboard. Every open song has its own editor, but they share one clipboard,
 * so beats or bars copied in one tab can be pasted into another (#228).
 */
import type { Beat } from "@/lib/score/model";
import type { TrackKind } from "@/lib/score/music";

/** A copied beat, with the sounding pitch of each note (a detached note can't compute it). */
export interface CopiedBeat {
  beat: Beat;
  pitches: number[];
}

export interface ClipboardContent {
  /** The kind of track it was copied from: notes are converted when pasted elsewhere. */
  kind: TrackKind;
  /** Copied beats, one list per bar they came from. */
  bars: CopiedBeat[][];
}

/** Holds what was copied last. The beats are detached copies: pasting clones them again. */
export class EditorClipboard {
  private content: ClipboardContent | null = null;

  get(): ClipboardContent | null {
    return this.content;
  }

  set(content: ClipboardContent | null) {
    this.content = content;
  }

  clear() {
    this.content = null;
  }
}

/** The clipboard every editor of the app uses. */
export const sharedClipboard = new EditorClipboard();
