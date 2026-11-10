import type { Beat } from "@/lib/score/model";

/** What Play plays in edit mode (#228): from `start`, and only to `end` when it is set. */
export interface EditPlaySpan {
  start: Beat;
  end: Beat | null;
}

/**
 * Play in edit mode starts at the beat under the edit cursor and plays on; with several beats
 * selected it plays only those. Null when there is no beat to start at.
 */
export function editPlaySpan(editor: {
  cursorBeat(): Beat | null;
  selectedBeatList(): Beat[];
}): EditPlaySpan | null {
  const selected = editor.selectedBeatList();
  const first = selected[0];
  const last = selected.at(-1);
  if (first && last && first !== last) return { start: first, end: last };
  const beat = first ?? editor.cursorBeat();
  return beat ? { start: beat, end: null } : null;
}
