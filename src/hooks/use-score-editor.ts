import { useState, useSyncExternalStore } from "react";

import { ScoreEditor } from "@/lib/score/editor";
import type { Score } from "@/lib/score/model";

/**
 * The editor for an open song. The component re-renders whenever the music,
 * the cursor or the selection changes; read the editor's getters while rendering.
 */
export function useScoreEditor(score: Score): ScoreEditor {
  const [editor] = useState(() => new ScoreEditor(score));
  useSyncExternalStore(editor.subscribe, () => editor.version);
  return editor;
}
