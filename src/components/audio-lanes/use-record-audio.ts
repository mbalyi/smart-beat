import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import type { RecordPhase } from "@/hooks/use-record-to-tab";
import { addClip, addLane, addSource } from "@/lib/audio-lanes/edits";
import { MAX_LANES, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { monoWav, placeTake, type RecordMode } from "@/lib/audio-lanes/takes";
import { audioInputErrorText, readAudioInput } from "@/lib/audio/input";
import { meterLevel, smoothLevel } from "@/lib/audio/level";
import { startRecorder, type Recorder } from "@/lib/audio/recorder";
import { countInSeconds, downbeatInTake } from "@/lib/audio/take-timing";
import { errorText } from "@/lib/errors";
import { addAudioTake } from "@/lib/tauri";

/** The clock takes are timed on (`performance.now()`, as the recorder uses). */
const now = () => performance.now();

/** Takes shorter than this are thrown away ("nothing was recorded"). */
const MIN_TAKE_SECONDS = 0.5;

/** What the Record audio dialog asks for. */
export interface RecordAudioSetup {
  /** The lane the take goes on (null: a new lane). */
  laneId: string | null;
  mode: RecordMode;
  countIn: boolean;
  preRollBars: number;
}

/** The transport the recording drives (the score player). */
export interface RecordTransport {
  seekToBar(bar: number): void;
  playPause(): void;
  pause(): void;
  setCountIn(on: boolean): void;
  setLoop(range: { start: number; end: number } | null): void;
  outputLatencySeconds(): number;
}

/**
 * Records a plain audio take (no transcription) and puts it on a lane: the count-in, pre-roll and
 * latency are taken out, a punch keeps the selected bars only, and a loop recording becomes one
 * clip with a take per pass.
 */
export function useRecordAudio(env: {
  lanes: AudioLanesController;
  grid: SongGrid;
  transport: () => RecordTransport | null;
  /** The bar recording starts from (playhead mode). */
  startBar: () => number;
  /** The selected bars (punch and loop modes). */
  range: () => { start: number; end: number } | null;
  /** Seconds per beat at a bar, and beats in it (for the count-in). */
  beatAt: (bar: number) => { seconds: number; beats: number };
  /** The practice speed (1 = as written). */
  speed: () => number;
  ensureEngine: () => boolean;
}) {
  const [phase, setPhase] = useState<RecordPhase>({ kind: "idle" });
  const [level, setLevel] = useState(0);
  const session = useRef<{
    recorder: Recorder;
    setup: RecordAudioSetup;
    startBar: number;
    range: { start: number; end: number } | null;
    playBar: number;
    playStartedAt: number;
    countIn: number;
  } | null>(null);
  const envRef = useRef(env);
  useEffect(() => {
    envRef.current = env;
  });

  // The elapsed time on the recording bar.
  useEffect(() => {
    if (phase.kind !== "recording") return;
    const id = setInterval(() => {
      const s = session.current;
      if (s)
        setPhase((p) =>
          p.kind === "recording"
            ? {
                ...p,
                countingIn: now() < s.playStartedAt + s.countIn * 1000,
                elapsed: s.recorder.elapsed(),
              }
            : p,
        );
    }, 200);
    return () => clearInterval(id);
  }, [phase.kind]);

  // Leaving (another song, a closed tab) mid-take lets go of the input.
  useEffect(
    () => () => {
      const s = session.current;
      session.current = null;
      s?.recorder.cancel();
    },
    [],
  );

  /** A take is starting (the input is opening): a second press does nothing. */
  const starting = useRef(false);

  const start = async (setup: RecordAudioSetup) => {
    if (starting.current || session.current) return;
    starting.current = true;
    try {
      await begin(setup);
    } finally {
      starting.current = false;
    }
  };

  const begin = async (setup: RecordAudioSetup) => {
    const { transport, startBar, range, beatAt, speed, ensureEngine } = envRef.current;
    if (!ensureEngine()) return;
    const player = transport();
    if (!player) return;
    const selected = range();
    if (setup.mode !== "playhead" && !selected) {
      toast.info("Select the bars to record first", {
        description: "Drag across the bars in the score or on the time ruler.",
      });
      return;
    }
    let recorder: Recorder;
    try {
      recorder = await startRecorder(readAudioInput(), {
        onLevel: (peak) => setLevel((l) => smoothLevel(l, meterLevel(peak))),
        onLimit: () => void stop(),
      });
    } catch (error) {
      toast.error("Couldn't start recording", { description: audioInputErrorText(error) });
      return;
    }
    const punchBar = setup.mode === "playhead" || !selected ? startBar() : selected.start;
    const playBar = Math.max(0, punchBar - setup.preRollBars);
    const beat = beatAt(playBar);
    player.pause();
    player.setLoop(setup.mode === "loop" ? selected : null);
    player.setCountIn(setup.countIn);
    player.seekToBar(playBar);
    const playStartedAt = now();
    player.playPause();
    session.current = {
      recorder,
      setup,
      startBar: punchBar,
      range: selected,
      playBar,
      playStartedAt,
      countIn: setup.countIn ? countInSeconds(beat.beats, beat.seconds, speed()) : 0,
    };
    setPhase({ kind: "recording", mode: "free", countingIn: setup.countIn, elapsed: 0 });
  };

  const stop = async () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    const { lanes, grid, transport, speed } = envRef.current;
    const player = transport();
    const outputLatency = player?.outputLatencySeconds() ?? 0;
    player?.pause();
    player?.setLoop(null);
    setPhase({ kind: "idle" });
    setLevel(0);
    const take = await s.recorder.stop();
    if (take.capped) toast.info("The take reached the limit of 10 minutes and was stopped.");
    if (take.samples.length < MIN_TAKE_SECONDS * take.sampleRate) {
      toast.info("Nothing was recorded", { description: "Play for a few seconds, then stop." });
      return;
    }
    const downbeat = downbeatInTake({
      playStartedAt: s.playStartedAt,
      countIn: s.countIn,
      takeStartedAt: take.startedAt,
      outputLatency,
      inputLatency: take.inputLatency,
    });
    const placement = placeTake({
      audio: lanes.audio,
      grid,
      mode: s.setup.mode,
      startBar: s.startBar,
      range: s.range,
      preRollBars: s.startBar - s.playBar,
      downbeat,
      takeMs: (take.samples.length / take.sampleRate) * 1000,
      speed: speed(),
    });
    if (!placement) {
      toast.info("Nothing was recorded after the start bar");
      return;
    }
    const name = `Take ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.wav`;
    // The take needs a lane: the chosen one (not a folder), or room for a new one.
    const chosen = lanes.audio.lanes.find((l) => l.id === s.setup.laneId && !l.folder);
    if (!chosen && lanes.audio.lanes.length >= MAX_LANES) {
      toast.error("The take was not kept", {
        description: `A song can have ${MAX_LANES} audio lanes: pick one of them in Record audio.`,
      });
      return;
    }
    try {
      const info = await addAudioTake(name, monoWav(take.samples, take.sampleRate));
      lanes.apply((a) => {
        let next = addSource(a, { id: info.id, name, ext: "wav", embedded: true });
        let laneId = chosen?.id;
        if (!laneId || !next.lanes.some((l) => l.id === laneId && !l.folder)) {
          if (next.lanes.length >= MAX_LANES) return a;
          const lane = newLane("Recording");
          next = addLane(next, lane);
          laneId = lane.id;
        }
        const clip = newClip(info.id, name, placement.startMs, placement.lengthMs);
        const takes = placement.passes.map((offsetMs, i) => ({
          name: placement.passes.length > 1 ? `Pass ${i + 1}` : name,
          sourceId: info.id,
          offsetMs,
        }));
        return addClip(next, laneId, { ...clip, takes, take: takes.length - 1 });
      });
      toast.success(
        placement.passes.length > 1
          ? `Recorded ${placement.passes.length} takes`
          : "Recorded a take",
      );
    } catch (error) {
      toast.error("Couldn't keep the take", { description: errorText(error) });
    }
  };

  const discard = () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.recorder.cancel();
    envRef.current.transport()?.pause();
    envRef.current.transport()?.setLoop(null);
    setPhase({ kind: "idle" });
    setLevel(0);
  };

  return {
    phase,
    level,
    start: (setup: RecordAudioSetup) => void start(setup),
    stop: () => void stop(),
    discard,
  };
}
