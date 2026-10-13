import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { RecordSetup, RecordTarget } from "@/components/score/record-dialog";
import { audioInputErrorText, readAudioInput } from "@/lib/audio/input";
import { decodeTake } from "@/lib/audio/decode-take";
import type { RecordInstrument } from "@/lib/audio/record-prefs";
import { meterLevel, smoothLevel } from "@/lib/audio/level";
import { startRecorder, type Recorder, type Take } from "@/lib/audio/recorder";
import {
  countInSeconds,
  downbeatInTake,
  offsetNotes,
  shiftNotes,
  type TakeTiming,
} from "@/lib/audio/take-timing";
import { errorText } from "@/lib/errors";
import {
  alignOffset,
  recordingTargets,
  recordingToSong,
  writeRecording,
  type RecordedNote,
} from "@/lib/import/recording";
import { splitHands } from "@/lib/import/hand-split";
import type { ScoreEditor } from "@/lib/score/editor";
import type { Score } from "@/lib/score/model";
import { getPreset } from "@/lib/score/music";
import type { ScorePlayer } from "@/lib/score/player";
import type { LoopRange } from "@/lib/score/practice";
import type { MixerSettings } from "@/lib/tauri";
import { tempoAt } from "@/lib/score/structure";
import { createTrack, insertTrack, uniqueTrackName } from "@/lib/score/tracks";
import {
  cancelRecordingTranscription,
  isRecordingStopped,
  isTauri,
  transcribeRecording,
} from "@/lib/tauri";
import { track } from "@/lib/telemetry";

/** A take shorter than this holds nothing worth transcribing (seconds). */
const MIN_TAKE_SECONDS = 0.5;

/** The name of a new track and of the song a free take becomes. */
const RECORDING_NAME = "Recording";

/** What the recording bar shows. */
export type RecordPhase =
  | { kind: "idle" }
  | { kind: "recording"; mode: RecordSetup["mode"]; countingIn: boolean; elapsed: number }
  | { kind: "transcribing"; fraction: number };

/** What the hook needs from the workspace. */
export interface RecordEnv {
  score: Score;
  editor: Pick<ScoreEditor, "run" | "structureTargets" | "placeCursorOnTrack" | "undo">;
  /** The song's player, or null while there is none. */
  player: () => Pick<
    ScorePlayer,
    | "setMetronome"
    | "setCountIn"
    | "setLoop"
    | "seekToBar"
    | "playPause"
    | "pause"
    | "outputLatencySeconds"
  > | null;
  /** Playback is possible: the sounds and the song are loaded. */
  ready: boolean;
  /** Playback settings now, and what to put back afterwards. */
  practice: () => { metronome: boolean; countIn: boolean; loop: LoopRange | null; speed: number };
  /** The mix now. */
  mix: () => MixerSettings;
  /** Mutes and unmutes tracks, and sets their solo, without counting it as a use of the mixer. */
  setTrackStates: (states: { track: number; mute: boolean; solo: boolean }[]) => void;
  /** Opens a score as a new song that exists only in memory (free mode). */
  onOpenScore: (score: Score, name: string) => void;
}

/** The part of the flow the dialog and the bar need. */
export interface RecordToTab {
  phase: RecordPhase;
  /** The loudest recent sound, 0…1. */
  level: number;
  dialogOpen: boolean;
  /** The track chosen when the dialog opened (an index), if any. */
  dialogTrack: number | null;
  open: (track?: number) => void;
  close: () => void;
  start: (setup: RecordSetup) => void;
  /** Turns an existing recording into tab or piano staves, as a new song. */
  fromFile: (file: File, tuning: number[], instrument: RecordInstrument) => void;
  /** Ends the take and transcribes it. */
  stop: () => void;
  /** Ends the take and throws it away. */
  discard: () => void;
  /** Stops the transcription. */
  cancel: () => void;
}

/** The stringed and pitched tracks of a score, which a take can go on. */
export function recordTargets(tracks: readonly { name: string; kind: string }[]): RecordTarget[] {
  return tracks.flatMap((t, index) =>
    t.kind === "stringed" || t.kind === "pitched"
      ? [{ index, name: t.name, kind: t.kind as RecordTarget["kind"] }]
      : [],
  );
}

/**
 * Record to Tab: records a take (with the click and the song in click mode), turns it into
 * notes and puts them on the score, or opens them as a new song (free mode).
 */
export function useRecordToTab(env: RecordEnv): RecordToTab {
  const [dialog, setDialog] = useState<{ open: boolean; track: number | null }>({
    open: false,
    track: null,
  });
  const [phase, setPhase] = useState<RecordPhase>({ kind: "idle" });
  const [level, setLevel] = useState(0);
  // The latest props, for what runs later (the end of a take, a key press).
  const envRef = useRef(env);
  useEffect(() => {
    envRef.current = env;
  });

  /** The take in progress. */
  const session = useRef<{
    recorder: Recorder;
    setup: RecordSetup;
    /** Click mode: when playback started (`performance.now()`), and the count-in's length. */
    playStartedAt: number | null;
    countIn: number;
    beatSeconds: number;
    speed: number;
    /** Puts back the metronome, count-in, loop and mix. */
    restore: () => void;
  } | null>(null);
  /** The recorder is being opened (the system may be asking): the player ended the take already. */
  const starting = useRef<{ aborted: boolean } | null>(null);
  const transcribing = useRef(false);
  const latest = useRef<{ finish: () => Promise<void>; discard: () => void } | null>(null);
  const levelRef = useRef(0);

  // The elapsed time, and whether the count-in is still going.
  const recording = phase.kind === "recording";
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const current = session.current;
      if (!current) return;
      setLevel((levelRef.current = smoothLevel(levelRef.current, 0, 0.7)));
      setPhase({
        kind: "recording",
        mode: current.setup.mode,
        countingIn: countingIn(current),
        elapsed: current.recorder.elapsed(),
      });
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  const endTake = useCallback((discarded: boolean) => {
    const current = session.current;
    session.current = null;
    if (!current) return null;
    current.restore();
    if (discarded) current.recorder.cancel();
    return current;
  }, []);

  /** Shows the transcription bar while `work` runs, and reports how it ended. */
  const transcribe = async (work: () => Promise<void>, failure: string) => {
    transcribing.current = true;
    setPhase({ kind: "transcribing", fraction: 0 });
    setLevel(0);
    try {
      await work();
    } catch (error) {
      if (isRecordingStopped(error)) {
        toast.info("Transcription stopped", { description: "Your take was not added." });
      } else {
        toast.error(failure, { description: errorText(error) });
      }
    } finally {
      transcribing.current = false;
      setPhase({ kind: "idle" });
    }
  };

  const notesOf = (samples: Float32Array, sampleRate: number, instrument: RecordInstrument) =>
    transcribeRecording(
      samples,
      sampleRate,
      (fraction) => setPhase({ kind: "transcribing", fraction }),
      instrument,
    );

  const finish = async () => {
    const current = session.current;
    // Stopped while the input was still being opened: there is no take.
    if (!current && starting.current) starting.current.aborted = true;
    if (!current || transcribing.current) return;
    const { setup } = current;
    const { score } = envRef.current;
    // The track itself, so that a track moved during the transcription is still found.
    const target = setup.track === null ? null : (score.tracks[setup.track] ?? null);
    await transcribe(async () => {
      // Playback stops with the take.
      const latency = envRef.current.player()?.outputLatencySeconds() ?? 0;
      endTake(false);
      const take = await current.recorder.stop();
      if (take.capped) toast.info("The take reached the limit of 10 minutes and was stopped.");
      if (take.samples.length < MIN_TAKE_SECONDS * take.sampleRate) {
        toast.info("Nothing was recorded", { description: "Play for a few seconds, then stop." });
        return;
      }
      const heard = await notesOf(take.samples, take.sampleRate, setup.instrument);
      if (heard.length === 0) {
        toast.info("No notes were heard", {
          description: "Check the level in the Record to Tab dialog, then try again.",
        });
        return;
      }
      if (setup.mode === "free") {
        showWarnings(openAsSong(heard, setup.tuning, RECORDING_NAME, setup.instrument));
      } else {
        // The song may have been edited while the take was transcribed: write into the song
        // and the track as they are now, or not at all.
        const now = envRef.current;
        const index = target ? now.score.tracks.indexOf(target) : null;
        if (now.score !== score || index === -1) {
          toast.error("The song changed while your take was transcribed", {
            description: "Your take was not added. Record it again.",
          });
          return;
        }
        const notes = clickNotes(heard, take, current, latency, setup.alignToBeat);
        const added = addToScore(now.score, now.editor, notes, { ...setup, track: index });
        const name = now.score.tracks[added.track]?.name ?? "the track";
        toast(`Added your take to “${name}”`, {
          action: { label: "Undo", onClick: () => now.editor.undo() },
        });
        showWarnings(added.warnings);
      }
      track("record_to_tab");
    }, "Couldn't turn your take into tab");
  };

  /** Free mode: opens the notes as a new song. Returns what could not be written exactly. */
  const openAsSong = (
    heard: readonly RecordedNote[],
    tuning: number[],
    name: string,
    instrument: RecordInstrument,
  ) => {
    const piano = instrument === "piano";
    const result = recordingToSong(heard, {
      tuning: piano ? undefined : tuning,
      trackName: RECORDING_NAME,
      program: getPreset(piano ? "piano" : "guitar")?.program ?? (piano ? 0 : 25),
    });
    envRef.current.onOpenScore(result.score, name);
    return result.warnings;
  };

  /** An existing recording: turns it into notes and opens them as a new song, like free mode. */
  const fromFile = (file: File, tuning: number[], instrument: RecordInstrument) => {
    if (transcribing.current || session.current) return;
    setDialog({ open: false, track: null });
    void transcribe(async () => {
      const decoded = await decodeTake(await file.arrayBuffer());
      const heard = await notesOf(decoded.samples, decoded.sampleRate, instrument);
      if (heard.length === 0) {
        toast.info("No notes were heard", {
          description: "Choose a recording where the instrument is clear and loud enough.",
        });
        return;
      }
      showWarnings(
        openAsSong(heard, tuning, file.name.replace(/\.[^.]+$/, "") || RECORDING_NAME, instrument),
      );
      track("record_to_tab");
    }, "Couldn't turn this recording into tab");
  };

  const begin = async (setup: RecordSetup) => {
    const { score, player: getPlayer, ready, practice, mix, setTrackStates } = envRef.current;
    const click = setup.mode === "click";
    const player = getPlayer();
    if (click && (!player || !ready)) {
      toast.error("The song is not ready yet", {
        description: "The instrument sounds are still loading. Try again in a moment.",
      });
      return;
    }
    setPhase({ kind: "recording", mode: setup.mode, countingIn: click, elapsed: 0 });
    levelRef.current = 0;
    const attempt = { aborted: false };
    starting.current = attempt;
    let recorder: Recorder;
    try {
      recorder = await startRecorder(readAudioInput(), {
        onLevel: (peak) => {
          levelRef.current = smoothLevel(levelRef.current, meterLevel(peak));
          setLevel(levelRef.current);
        },
        onLimit: () => void latest.current?.finish(),
      });
    } catch (error) {
      starting.current = null;
      setPhase({ kind: "idle" });
      if (!attempt.aborted) {
        toast.error("Couldn't start recording", { description: audioInputErrorText(error) });
      }
      return;
    }
    starting.current = null;
    if (attempt.aborted) {
      recorder.cancel();
      setPhase({ kind: "idle" });
      return;
    }

    const masterBar = score.masterBars[setup.startBar];
    const beats = masterBar?.timeSignatureNumerator ?? 4;
    const beatSeconds =
      (60 / tempoAt(score, setup.startBar)) * (4 / (masterBar?.timeSignatureDenominator ?? 4));
    const before = practice();
    const speed = before.speed / 100;
    const mixBefore = mix().tracks.map((t) => ({ mute: t.mute, solo: t.solo }));
    const current: NonNullable<typeof session.current> = {
      recorder,
      setup,
      playStartedAt: null,
      countIn: countInSeconds(beats, beatSeconds, speed),
      beatSeconds,
      speed,
      restore: () => {
        if (!click || !player) return;
        player.pause();
        player.setMetronome(before.metronome);
        player.setCountIn(before.countIn);
        player.setLoop(before.loop);
        setTrackStates(mixBefore.map((state, i) => ({ track: i, ...state })));
      },
    };
    session.current = current;

    if (click && player) {
      // The target track is silent (it is what is played), the others only if asked.
      setTrackStates(
        mixBefore.map((_, i) => ({
          track: i,
          mute: i === setup.track || !setup.playOthers,
          solo: false,
        })),
      );
      player.pause();
      player.setLoop(null);
      player.setMetronome(true);
      player.setCountIn(true);
      player.seekToBar(setup.startBar);
      current.playStartedAt = performance.now();
      player.playPause();
    } else {
      setPhase({ kind: "recording", mode: "free", countingIn: false, elapsed: 0 });
    }
  };

  const start = (setup: RecordSetup) => {
    setDialog({ open: false, track: null });
    void begin(setup);
  };

  const stop = () => void finish();

  const discard = () => {
    if (starting.current) starting.current.aborted = true;
    const current = endTake(true);
    if (!current) return;
    setPhase({ kind: "idle" });
    setLevel(0);
  };

  // For what runs later: the end of a take at its limit, and key presses.
  useEffect(() => {
    latest.current = { finish, discard };
  });

  const cancel = () => {
    if (transcribing.current) void cancelRecordingTranscription().catch(() => {});
  };

  // Space and Escape end the take; Escape during the count-in throws it away.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== " " && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const current = session.current;
      if (event.key === "Escape" && (!current || countingIn(current))) latest.current?.discard();
      else void latest.current?.finish();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording]);

  // Closing the song (or the app) ends the take.
  useEffect(
    () => () => {
      endTake(true);
      if (transcribing.current) void cancelRecordingTranscription().catch(() => {});
    },
    [endTake],
  );

  return {
    phase,
    level,
    dialogOpen: dialog.open,
    dialogTrack: dialog.track,
    open: (track) => setDialog({ open: true, track: track ?? null }),
    close: () => setDialog({ open: false, track: null }),
    start,
    fromFile,
    stop,
    discard,
    cancel,
  };
}

/** Click mode, before the downbeat of the start bar: the count-in is still going. */
function countingIn(current: {
  setup: RecordSetup;
  playStartedAt: number | null;
  countIn: number;
}) {
  if (current.setup.mode !== "click") return false;
  if (current.playStartedAt === null) return true;
  return performance.now() < current.playStartedAt + current.countIn * 1000;
}

/** The notes of a click-mode take, with time 0 at the start bar's downbeat, lined up with the beat if asked. */
function clickNotes(
  heard: readonly RecordedNote[],
  take: Take,
  current: { playStartedAt: number | null; countIn: number; beatSeconds: number; speed: number },
  outputLatency: number,
  alignToBeat: boolean,
): RecordedNote[] {
  const timing: TakeTiming = {
    playStartedAt: current.playStartedAt ?? take.startedAt,
    countIn: current.countIn,
    takeStartedAt: take.startedAt,
    outputLatency,
    inputLatency: take.inputLatency,
  };
  const placed = shiftNotes(heard, downbeatInTake(timing), current.speed);
  return alignToBeat ? offsetNotes(placed, alignOffset(placed, current.beatSeconds)) : placed;
}

/**
 * Click mode: writes the notes on the chosen track (or a new one) as one undo step. Returns
 * the index of the track and what could not be written exactly.
 */
function addToScore(
  score: Score,
  editor: RecordEnv["editor"],
  notes: readonly RecordedNote[],
  setup: RecordSetup,
): { track: number; warnings: string[] } {
  let warnings: string[] = [];
  const target = setup.track === null ? null : (score.tracks[setup.track] ?? null);
  let index = setup.track ?? -1;
  editor.run(
    "Record to tab",
    () =>
      // A new track does not exist before the edit: then the structure is what changes.
      index >= 0 && score.tracks[index]
        ? recordingTargets(score, index, setup.startBar)
        : editor.structureTargets(),
    () => {
      const piano = setup.instrument === "piano";
      if (setup.track === null) {
        // A piano gets a track for each hand; a hand with no notes gets none.
        const hands = piano ? splitHands(notes) : null;
        const made = (hands ? [hands.right, hands.left] : [notes]).map((list, hand) => ({
          list,
          bass: hand === 1,
        }));
        const used = made.filter(({ list }) => list.length > 0 || !hands);
        for (const { list, bass } of used) {
          const created = createTrack(
            score,
            piano
              ? {
                  kind: "pitched",
                  name: uniqueTrackName(
                    score,
                    bass ? `${RECORDING_NAME} (left hand)` : RECORDING_NAME,
                  ),
                  program: getPreset("piano")?.program ?? 0,
                  bass,
                }
              : {
                  kind: "stringed",
                  name: uniqueTrackName(score, RECORDING_NAME),
                  program: getPreset("guitar")?.program ?? 25,
                  tuning: setup.tuning,
                },
          );
          insertTrack(score, created);
          const at = score.tracks.indexOf(created);
          if (index < 0) index = at;
          warnings = [
            ...warnings,
            ...writeRecording(score, list, { trackIndex: at, startBar: setup.startBar }).warnings,
          ];
        }
        warnings = [...new Set(warnings)];
      } else {
        index = score.tracks.indexOf(target!);
        warnings = writeRecording(score, notes, {
          trackIndex: index,
          startBar: setup.startBar,
        }).warnings;
      }
      editor.placeCursorOnTrack(index);
    },
  );
  return { track: index, warnings };
}

/** Tells the player what could not be written exactly. */
function showWarnings(warnings: readonly string[]) {
  if (warnings.length === 0) return;
  toast.warning("Your take was simplified", { description: warnings.join(" "), duration: 12_000 });
}

/** True where Record to Tab can run: it needs the desktop app's transcriber. */
export const canRecordToTab = () => isTauri();
