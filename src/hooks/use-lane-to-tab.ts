import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { LaneToTabRequest, LaneRange } from "@/lib/audio-lanes/lane-transcribe-request";
import { describeBars, INSTRUMENT_LABEL, type LanePart } from "@/lib/audio-lanes/lane-transcribe";
import type { RecordEngine, RecordInstrument } from "@/lib/audio/record-prefs";
import { errorText } from "@/lib/errors";
import { cleanDrumHits } from "@/lib/import/drum-hits";
import { placeTake, programFor, RECORDING_NAME, type PlacedTake } from "@/lib/import/place-take";
import { recordingTargets, recordingToSong, type RecordedNote } from "@/lib/import/recording";
import type { ScoreEditor } from "@/lib/score/editor";
import type { Score } from "@/lib/score/model";
import {
  cancelLaneTranscription,
  isRecordingStopped,
  transcribeLane,
  type MuscriptorSize,
} from "@/lib/tauri";
import { getAiState, rightsDetail } from "@/lib/ai/ai-store";
import { track } from "@/lib/telemetry";

/** Where a part goes in the song: a track (an index) or a new one, from this bar (0-based). */
export interface PartTarget {
  track: number | null;
  bar: number;
}

/** What the host needs from the workspace. */
export interface LaneToTabEnv {
  score: Score;
  editor: Pick<ScoreEditor, "run" | "structureTargets" | "placeCursorOnTrack" | "undo">;
  /** Opens a score as a new song that exists only in memory. */
  onOpenScore: (score: Score, name: string) => void;
  /** True where this tab may not be written to (a Practice together guest); says why itself. */
  blocked: () => boolean;
}

/** The dialog's host: which request it was opened with, and the one way a part is written. */
export interface LaneToTabHost {
  /** The request the dialog is open with (null: closed). */
  request: LaneToTabRequest | null;
  /** Changes with every opening, so a reopened dialog starts from its defaults again. */
  nonce: number;
  open: (request: LaneToTabRequest) => void;
  close: () => void;
  /**
   * Writes a part into the tab as one undo step: the same call for the button, the keyboard and
   * a drop. Returns what was written, or null when it could not be.
   */
  place: (part: LanePart, target: PartTarget, options?: { toast?: boolean }) => PlacedTake | null;
  /** Opens the part as a new song. */
  newTab: (part: LanePart) => boolean;
  /** Undoes the last write (the result card's button). */
  undo: () => void;
}

/** Tells the player what could not be written exactly. */
export function showPartWarnings(warnings: readonly string[]) {
  if (warnings.length === 0) return;
  toast.warning("The part was simplified", { description: warnings.join(" "), duration: 12_000 });
}

/** The name of the song a part becomes when it is opened by itself. */
export const partSongName = (part: LanePart) => `${part.laneName || "Audio track"} (sheet)`;

/**
 * "Sheet from an audio lane" (#235), the part that lives in the workspace: whether the dialog is
 * open and the one place where a transcribed part is written, so that the button, the keyboard
 * and a drop on the score all do exactly the same thing.
 */
export function useLaneToTab(env: LaneToTabEnv): LaneToTabHost {
  const [state, setState] = useState<{ request: LaneToTabRequest | null; nonce: number }>({
    request: null,
    nonce: 0,
  });
  const envRef = useRef(env);
  useEffect(() => {
    envRef.current = env;
  });

  const place = useCallback<LaneToTabHost["place"]>((part, target, options = {}) => {
    const { score, editor, blocked } = envRef.current;
    if (blocked()) return null;
    let placed: PlacedTake | null = null;
    const existing = target.track !== null ? (score.tracks[target.track] ?? null) : null;
    const index = existing ? score.tracks.indexOf(existing) : -1;
    try {
      editor.run(
        "Add transcribed part",
        () =>
          // A new track does not exist before the edit: then the structure is what changes.
          index >= 0 ? recordingTargets(score, index, target.bar) : editor.structureTargets(),
        () => {
          placed = placeTake(score, part.take, {
            instrument: part.instrument,
            tuning: part.tuning,
            track: index >= 0 ? index : null,
            startBar: target.bar,
            trackName: RECORDING_NAME,
          });
          editor.placeCursorOnTrack(placed.track);
        },
      );
    } catch (error) {
      toast.error("Couldn't add the part to the tab", { description: errorText(error) });
      return null;
    }
    const done = placed as PlacedTake | null;
    if (!done) return null;
    if (options.toast !== false) {
      const name = score.tracks[done.track]?.name ?? "the track";
      toast(
        `Added ${INSTRUMENT_LABEL[part.instrument]} to “${name}”, ${describeBars(done.firstBar, done.lastBar)}`,
        { action: { label: "Undo", onClick: () => envRef.current.editor.undo() } },
      );
    }
    showPartWarnings(done.warnings);
    return done;
  }, []);

  const newTab = useCallback<LaneToTabHost["newTab"]>((part) => {
    // Time 0 is the start of the converted span, and the tempo is measured from the notes.
    const origin = part.span.startMs / 1000;
    const notes = part.notes.map((n) => ({ ...n, start: n.start - origin, end: n.end - origin }));
    try {
      const drums = part.instrument === "drums";
      const piano = part.instrument === "piano";
      const song = recordingToSong(notes, {
        tuning: piano || drums ? undefined : part.tuning,
        trackName: drums ? "Drums" : RECORDING_NAME,
        program: programFor(part.instrument),
        drums,
      });
      envRef.current.onOpenScore(song.score, partSongName(part));
      showPartWarnings(song.warnings);
      return true;
    } catch (error) {
      toast.error("Couldn't make a tab from this part", { description: errorText(error) });
      return false;
    }
  }, []);

  const open = useCallback<LaneToTabHost["open"]>(
    (request) => setState((s) => ({ request, nonce: s.nonce + 1 })),
    [],
  );
  const close = useCallback(() => setState((s) => ({ ...s, request: null })), []);

  return {
    request: state.request,
    nonce: state.nonce,
    open,
    close,
    place,
    newTab,
    undo: () => envRef.current.editor.undo(),
  };
}

// --- The transcription job -------------------------------------------------------------

/** What the job shows. */
export type LaneJob =
  { kind: "idle" } | { kind: "running"; fraction: number } | { kind: "failed"; message: string };

/** What is converted, and how. */
export interface LaneJobInput {
  laneId: string;
  /** One clip is sent by id; otherwise the span. */
  clipId?: string;
  span: LaneRange | null;
  instrument: RecordInstrument;
  engine: RecordEngine;
}

/** The notes found, and the span they cover (timeline ms). */
export interface LaneFound {
  notes: RecordedNote[];
  span: LaneRange;
}

/**
 * Runs the transcription of a lane, clip or span and reports its progress. Stops it when the
 * dialog goes away. `run` resolves to what was found, or null when it was stopped or failed
 * (then `job` says why).
 */
export function useLaneTranscription() {
  const [job, setJob] = useState<LaneJob>({ kind: "idle" });
  const running = useRef(false);
  const stopped = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (running.current) void cancelLaneTranscription().catch(() => {});
    };
  }, []);

  const run = useCallback(async (input: LaneJobInput): Promise<LaneFound | null> => {
    if (running.current) return null;
    running.current = true;
    stopped.current = false;
    setJob({ kind: "running", fraction: 0 });
    // Counted when it starts, per instrument; MuScriptor also counts for the rights counter.
    track("lane_transcribe", input.instrument);
    if (input.engine === "muscriptor") track("ai_transcribe_file", rightsDetail());
    try {
      const found = await transcribeLane(
        {
          laneId: input.laneId,
          ...(input.clipId
            ? { clipId: input.clipId }
            : input.span
              ? { startMs: input.span.startMs, endMs: input.span.endMs }
              : {}),
          instrument: input.instrument,
          engine: input.engine,
          modelSize: getAiState().size as MuscriptorSize,
        },
        (fraction) => alive.current && setJob({ kind: "running", fraction }),
      );
      if (!alive.current) return null;
      const notes = input.instrument === "drums" ? cleanDrumHits(found.notes) : [...found.notes];
      setJob({ kind: "idle" });
      return { notes, span: { startMs: found.startMs, endMs: found.endMs } };
    } catch (error) {
      if (alive.current) {
        setJob(
          stopped.current || isRecordingStopped(error)
            ? { kind: "idle" }
            : { kind: "failed", message: errorText(error) },
        );
      }
      return null;
    } finally {
      running.current = false;
    }
  }, []);

  const stop = useCallback(() => {
    if (!running.current) return;
    stopped.current = true;
    void cancelLaneTranscription().catch(() => {});
  }, []);

  const clear = useCallback(() => setJob({ kind: "idle" }), []);
  return { job, run, stop, clear };
}
