import { useState, useSyncExternalStore } from "react";

import { ScoreEditor } from "@/lib/score/editor";
import type { Score } from "@/lib/score/model";

/**
 * The editor for an open song. The component re-renders whenever the music,
 * the cursor or the selection changes; read the editor's getters while rendering.
 * An `unsaved` song exists only in memory and counts as edited until its first save.
 */
export function useScoreEditor(score: Score, unsaved = false): ScoreEditor {
  const [editor] = useState(() => {
    const editor = new ScoreEditor(score);
    if (unsaved) editor.markUnsaved();
    return editor;
  });
  useSyncExternalStore(editor.subscribe, () => editor.version);
  return editor;
}
