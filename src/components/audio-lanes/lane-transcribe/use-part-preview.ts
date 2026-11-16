import { useEffect, useRef, useState } from "react";

import { countNotes, type LanePart, type PlaceChoice } from "@/lib/audio-lanes/lane-transcribe";
import { errorText } from "@/lib/errors";
import { placeTake, programFor, RECORDING_NAME } from "@/lib/import/place-take";
import { recordingToSong } from "@/lib/import/recording";
import { cloneScore, refinish, type Score } from "@/lib/score/model";

/** What the part would look like once written. */
export interface PartPreviewResult {
  /** A detached song with the part written in; never the live one. */
  score: Score;
  /** The track the part lands on, in `score`. */
  track: number;
  firstBar: number;
  lastBar: number;
  appended: number;
  warnings: string[];
  /** Notes the part replaces on the live track. */
  existingNotes: number;
  kind: PlaceChoice["kind"];
}

/** How long the placement waits for the choices to settle before it is worked out again (ms). */
export const PREVIEW_DEBOUNCE_MS = 250;

/**
 * Works out the placement on a copy of the song (the same `placeTake` as the final write, so
 * the picture cannot differ from the result).
 */
export function computePreview(
  live: Score | null,
  part: LanePart,
  place: PlaceChoice,
  bar: number,
): PartPreviewResult {
  if (place.kind === "new-tab" || !live) {
    const origin = part.span.startMs / 1000;
    const drums = part.instrument === "drums";
    const piano = part.instrument === "piano";
    const song = recordingToSong(
      part.notes.map((n) => ({ ...n, start: n.start - origin, end: n.end - origin })),
      {
        tuning: piano || drums ? undefined : part.tuning,
        trackName: drums ? "Drums" : RECORDING_NAME,
        program: programFor(part.instrument),
        drums,
      },
    );
    return {
      score: song.score,
      track: 0,
      firstBar: 0,
      lastBar: song.score.masterBars.length - 1,
      appended: 0,
      warnings: song.warnings,
      existingNotes: 0,
      kind: "new-tab",
    };
  }
  const copy = cloneScore(live);
  const placed = placeTake(copy, part.take, {
    instrument: part.instrument,
    tuning: part.tuning,
    track: place.kind === "track" ? place.index : null,
    startBar: bar,
  });
  // The editor links the song up again after every change; the copy has no editor.
  refinish(copy);
  return {
    score: copy,
    track: placed.track,
    firstBar: placed.firstBar,
    lastBar: Math.max(placed.firstBar, placed.lastBar),
    appended: placed.appended,
    warnings: placed.warnings,
    existingNotes:
      place.kind === "track" ? countNotes(live, place.index, placed.firstBar, placed.lastBar) : 0,
    kind: place.kind,
  };
}

/**
 * The placement on a copy of the song. Changes of the choices are debounced, and an older result
 * never replaces a newer one.
 */
export function usePartPreview(
  live: Score | null,
  part: LanePart | null,
  place: PlaceChoice,
  bar: number,
  enabled: boolean,
  /** Changes when the live song is edited (it is changed in place). */
  revision = 0,
): { result: PartPreviewResult | null; pending: boolean; error: string } {
  const placeKey = place.kind === "track" ? `track:${place.index}` : place.kind;
  const key = `${placeKey}|${bar}|${revision}`;
  const [state, setState] = useState<{
    result: PartPreviewResult | null;
    error: string;
    part: LanePart | null;
    key: string;
  }>({ result: null, error: "", part: null, key: "" });
  const first = useRef(true);
  const placeRef = useRef(place);
  useEffect(() => {
    placeRef.current = place;
  });

  useEffect(() => {
    if (!enabled || !part) return;
    let current = true;
    const work = () => {
      if (!current) return;
      try {
        const result = computePreview(live, part, placeRef.current, bar);
        if (current) setState({ result, error: "", part, key });
      } catch (error) {
        if (current) setState({ result: null, error: errorText(error), part, key });
      }
    };
    // The first picture is made at once; later changes wait for the choices to settle.
    const timer = setTimeout(work, first.current ? 0 : PREVIEW_DEBOUNCE_MS);
    first.current = false;
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [enabled, live, part, key, bar]);

  // Pending until a result for these very choices is in.
  const pending = enabled && part !== null && (state.part !== part || state.key !== key);
  return { result: state.result, pending, error: state.error };
}
