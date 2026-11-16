import {
  AlphaTabApi,
  LayoutMode,
  model,
  NotationElement,
  PlayerMode,
  StaveProfile,
} from "@coderline/alphatab";
import { useEffect, useRef, useState } from "react";

import { applyPalette, baseRenderSettings } from "@/lib/score/render-settings";
import { SCORE_PALETTES, type ScoreTheme } from "@/lib/score/score-theme";
import type { Score } from "@/lib/score/model";

/** The colour of the notes that are new (a violet that reads on both papers). */
const NEW_NOTE = { light: [109, 40, 217], dark: [196, 167, 255] } as const;

/** Colours the notes of the bars `from` to `to` (0-based) of a track, so the new ones stand out. */
function colourNotes(
  score: Score,
  trackIndex: number,
  from: number,
  to: number,
  theme: ScoreTheme,
) {
  const [r, g, b] = NEW_NOTE[theme];
  const staff = score.tracks[trackIndex]?.staves[0];
  if (!staff) return;
  for (let i = from; i <= to; i++) {
    for (const voice of staff.bars[i]?.voices ?? []) {
      for (const beat of voice.beats) {
        for (const note of beat.notes) {
          const style = new model.NoteStyle();
          const colour = new model.Color(r, g, b, 255);
          style.colors.set(model.NoteSubElement.StandardNotationNoteHead, colour);
          style.colors.set(model.NoteSubElement.GuitarTabFretNumber, colour);
          style.colors.set(model.NoteSubElement.SlashNoteHead, colour);
          note.style = style;
        }
      }
    }
  }
}

/**
 * A few bars of a track, drawn read-only by their own alphaTab (no player, no editing, nothing
 * shared with the song on screen). The picture is decorative: the caption beside it says what is
 * in it.
 */
export function ScorePreview({
  score,
  trackIndex,
  firstBar,
  barCount,
  newFrom,
  newTo,
  theme,
  onRendered,
}: {
  /** A detached copy of the song with the part written in (see `cloneScore`). */
  score: Score;
  trackIndex: number;
  /** The first bar drawn (0-based) and how many. */
  firstBar: number;
  barCount: number;
  /** The bars whose notes are coloured as new (0-based, inclusive). */
  newFrom: number;
  newTo: number;
  theme: ScoreTheme;
  /** Called after each draw, with whether it went well. */
  onRendered?: (ok: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  const notify = useRef(onRendered);
  useEffect(() => {
    notify.current = onRendered;
  });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setDrawn(false);
    const settings = baseRenderSettings();
    // A handful of bars: drawn on the page's own thread, with no workers and no sound.
    settings.core.useWorkers = false;
    settings.player.playerMode = PlayerMode.Disabled;
    settings.display.layoutMode = LayoutMode.Page;
    settings.display.staveProfile = StaveProfile.Default;
    settings.display.startBar = firstBar + 1;
    settings.display.barCount = Math.max(1, barCount);
    settings.display.scale = 0.85;
    // Only the bars: no title block (the caption says what the picture is).
    for (const element of [
      NotationElement.ScoreTitle,
      NotationElement.ScoreSubTitle,
      NotationElement.ScoreArtist,
      NotationElement.ScoreAlbum,
      NotationElement.ScoreWords,
      NotationElement.ScoreMusic,
      NotationElement.ScoreWordsAndMusic,
      NotationElement.ScoreCopyright,
    ]) {
      settings.notation.elements.set(element, false);
    }
    applyPalette(settings, theme);
    let api: AlphaTabApi | null = null;
    try {
      api = new AlphaTabApi(element, settings);
      api.renderFinished.on(() => {
        setDrawn(true);
        notify.current?.(true);
      });
      colourNotes(score, trackIndex, newFrom, newTo, theme);
      api.renderScore(score, [trackIndex]);
    } catch {
      notify.current?.(false);
    }
    return () => {
      try {
        api?.destroy();
      } catch {
        // Already gone.
      }
    };
  }, [score, trackIndex, firstBar, barCount, newFrom, newTo, theme]);

  return (
    <div
      aria-hidden="true"
      data-testid="score-preview"
      data-drawn={drawn ? "true" : "false"}
      className="max-h-72 overflow-auto rounded-lg border"
      style={{ background: SCORE_PALETTES[theme].paper }}
    >
      <div ref={host} />
    </div>
  );
}
