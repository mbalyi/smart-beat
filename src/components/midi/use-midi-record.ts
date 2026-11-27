import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import type { RecordTransport } from "@/components/audio-lanes/use-record-audio";
import { addLane } from "@/lib/audio-lanes/edits";
import {
  DEFAULT_GRID,
  DEFAULT_QUANTIZE,
  gridAround,
  quantizeNotes,
} from "@/lib/audio-lanes/midi-edit";
import { newMidiLane } from "@/lib/audio-lanes/model";
import { timelineMsAtBar, type SongGrid } from "@/lib/audio-lanes/sync";
import { errorText } from "@/lib/errors";
import { readMidiPrefs, type MidiRecordPrefs } from "@/lib/midi/prefs";
import { applyRecording, eventsToPasses, punch, type Pass } from "@/lib/midi/record";
import { midiPanic, midiRecordStart, midiRecordStop } from "@/lib/tauri";

/** A recording is running on this lane. */
interface Session {
  laneId: string;
  prefs: MidiRecordPrefs;
  span: { startMs: number; endMs: number } | null;
}

/** Writes a recording's notes into the tab (the "Write into the tab" destination). */
export type WriteToTab = (laneId: string, clipId: string) => void;

/**
 * Recording on a MIDI lane (ADR 0006): the song plays from the playhead (or loops or punches the
 * selected bars) with the count-in and pre-roll of the last choices, what is played on the armed
 * lane is collected by the MIDI input with the timeline position the player heard, and Stop puts
 * it on the lane (or a new lane, or into the tab) in the chosen record mode as one Undo step.
 * Discarding throws the take away; every note is let go either way (the lane's record keys call
 * `stop` and `discard`).
 */
export function useMidiRecord(env: {
  lanes: AudioLanesController;
  grid: SongGrid;
  transport: () => RecordTransport | null;
  startBar: () => number;
  range: () => { start: number; end: number } | null;
  ensureEngine: () => boolean;
  writeToTab?: WriteToTab;
}) {
  const envRef = useRef(env);
  useEffect(() => {
    envRef.current = env;
  });
  const session = useRef<Session | null>(null);
  const [recording, setRecording] = useState<string | null>(null);

  // Leaving mid-take lets go of every note and of the recording.
  useEffect(
    () => () => {
      if (session.current) void midiRecordStop().catch(() => undefined);
      session.current = null;
    },
    [],
  );

  const start = async (laneId: string) => {
    if (session.current) return;
    const { transport, startBar, range, ensureEngine, lanes, grid } = envRef.current;
    if (!ensureEngine()) return;
    const player = transport();
    if (!player) return;
    const prefs = readMidiPrefs();
    const selected = range();
    if (prefs.span !== "playhead" && !selected) {
      toast.info("Select the bars to record first", {
        description: "Drag across the bars in the score or on the time ruler.",
      });
      return;
    }
    const punchBar = prefs.span === "playhead" || !selected ? startBar() : selected.start;
    const playBar = Math.max(0, punchBar - prefs.preRollBars);
    const span =
      prefs.span !== "playhead" && selected
        ? {
            startMs: timelineMsAtBar(lanes.audio, grid, selected.start),
            endMs: timelineMsAtBar(lanes.audio, grid, selected.end + 1),
          }
        : null;
    try {
      await midiRecordStart(Math.min(1000, Math.max(0, player.outputLatencySeconds() * 1000)));
    } catch (error) {
      toast.error("Couldn't start recording", { description: errorText(error) });
      return;
    }
    player.pause();
    player.setLoop(prefs.span === "loop" ? selected : null);
    player.setCountIn(prefs.countIn);
    player.seekToBar(playBar);
    player.playPause();
    session.current = { laneId, prefs, span };
    setRecording(laneId);
  };

  const finish = async (keep: boolean) => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    setRecording(null);
    const { transport, lanes, grid, writeToTab } = envRef.current;
    const player = transport();
    player?.pause();
    player?.setLoop(null);
    const stopMs = lanes.lineMs();
    let events: Awaited<ReturnType<typeof midiRecordStop>>;
    try {
      events = await midiRecordStop();
    } catch (error) {
      toast.error("Couldn't finish the recording", { description: errorText(error) });
      return;
    } finally {
      void midiPanic().catch(() => undefined);
    }
    if (!keep) return;
    let passes: Pass[] = eventsToPasses(events, stopMs);
    if (s.span) passes = passes.map((p) => punch(p, s.span!));
    if (s.prefs.inputQuantize) {
      const around = (ms: number) => gridAround(lanes.audio, grid, DEFAULT_GRID, ms);
      passes = passes.map((p) => ({
        ...p,
        notes: quantizeNotes(p.notes, 0, around, DEFAULT_QUANTIZE),
      }));
    }
    if (!passes.some((p) => p.notes.length > 0)) {
      toast.info("Nothing was recorded", {
        description: "Arm a MIDI lane, then play your pads, keyboard or the on-screen drums.",
      });
      return;
    }
    const source = lanes.audio.lanes.find((l) => l.id === s.laneId);
    let target = s.laneId;
    let clipId: string | null = null;
    lanes.apply((audio) => {
      let next = audio;
      if (s.prefs.destination === "newLane" && source) {
        const lane = newMidiLane(`${source.name} take`, source.instrument);
        next = addLane(next, lane);
        target = lane.id;
      }
      const result = applyRecording(next, target, passes, s.prefs.mode);
      clipId = result.clipId;
      return result.audio;
    });
    const notes = passes.reduce((n, p) => n + p.notes.length, 0);
    if (s.prefs.destination === "tab" && clipId && writeToTab) writeToTab(target, clipId);
    else toast.success(`Recorded ${notes} ${notes === 1 ? "note" : "notes"}.`);
  };

  return {
    /** The lane being recorded (null: none). */
    recording,
    start: (laneId: string) => start(laneId),
    stop: () => finish(true),
    discard: () => finish(false),
  };
}
