import { MicIcon, MicOffIcon, Volume2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  audioInputErrorText,
  openAudioInput,
  useAudioInput,
  type AudioInput,
} from "@/lib/audio/input";
import { detectPitch, midiOf, nearestString, samplesNeeded } from "@/lib/audio/pitch";
import { pitchName, tuningLabel } from "@/lib/score/music";
import { cn } from "@/lib/utils";

/** Within this many cents a string counts as in tune. */
export const IN_TUNE_CENTS = 5;

type MicState =
  | { kind: "off" }
  | { kind: "asking" }
  /** `device`: the name of the input heard (it may be empty). */
  | { kind: "listening"; device: string }
  | { kind: "blocked"; message: string };

interface Heard {
  /** Index of the closest string (in `tuning`), and how far off it is. */
  string: number;
  cents: number;
  /** The note heard, e.g. "E2". */
  note: string;
}

/**
 * Listens to the input chosen in Settings while `on` and reports the pitch heard. The input is
 * asked for only when listening starts, and released as soon as it stops (#83). Choosing
 * another input while listening switches to it.
 */
function useMicrophonePitch(on: boolean, tuning: readonly number[], input: AudioInput | null) {
  const [state, setState] = useState<MicState>({ kind: "off" });
  const [heard, setHeard] = useState<Heard | null>(null);
  const strings = useRef(tuning);
  useEffect(() => {
    strings.current = tuning;
  });

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const release = (s: MediaStream) => s.getTracks().forEach((track) => track.stop());
    (async () => {
      setState({ kind: "asking" });
      setHeard(null);
      try {
        const opened = await openAudioInput(input);
        // Stopped while the system was still asking: let go of the input straight away.
        if (stopped) {
          release(opened);
          return;
        }
        stream = opened;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        // A power of two that holds two periods of a bass's low B.
        let size = 2048;
        while (size < samplesNeeded(context.sampleRate)) size *= 2;
        analyser.fftSize = size;
        context.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        setState({ kind: "listening", device: stream.getAudioTracks()[0]?.label ?? "" });
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buffer);
          const pitch = detectPitch(buffer, context!.sampleRate);
          const near = pitch && nearestString(pitch.hz, strings.current);
          if (!pitch || !near) return;
          setHeard({
            string: near.index,
            cents: near.cents,
            note: pitchName(Math.round(midiOf(pitch.hz))),
          });
        }, 100);
      } catch (error) {
        if (stopped) return;
        setState({ kind: "blocked", message: audioInputErrorText(error) });
      }
    })();
    return () => {
      stopped = true;
      clearInterval(timer);
      if (stream) release(stream);
      void context?.close();
    };
  }, [on, input]);

  return on ? { state, heard } : { state: { kind: "off" } as MicState, heard: null };
}

/** A needle from −50 to +50 cents; in tune in the middle. */
function CentsMeter({ cents }: { cents: number | null }) {
  const clamped = cents === null ? 0 : Math.max(-50, Math.min(50, cents));
  const inTune = cents !== null && Math.abs(cents) <= IN_TUNE_CENTS;
  const words =
    cents === null
      ? "No note heard"
      : inTune
        ? "In tune"
        : `${Math.abs(cents)} cents ${cents < 0 ? "flat" : "sharp"}`;
  return (
    <div className="flex flex-col gap-1">
      <div
        role="meter"
        aria-label="Tuning"
        aria-valuemin={-50}
        aria-valuemax={50}
        aria-valuenow={clamped}
        aria-valuetext={words}
        className="relative h-6 rounded-md border bg-muted"
      >
        <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-foreground/40" />
        {cents !== null && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-y-0.5 w-1.5 -translate-x-1/2 rounded-full",
              inTune ? "bg-green-600" : "bg-amber-500",
            )}
            style={{ left: `${50 + clamped}%` }}
          />
        )}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span aria-hidden="true">♭ flat</span>
        <span className="font-medium text-foreground">{words}</span>
        <span aria-hidden="true">sharp ♯</span>
      </div>
    </div>
  );
}

/**
 * The tuner (#83): the open strings of the track to play and tune to by ear, and, if the
 * player wants it, the audio input chosen in Settings to show how far each string is off.
 */
export function TunerDialog({
  open,
  onOpenChange,
  trackName,
  tuning,
  onPlay,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackName: string;
  /** MIDI pitches of the open strings, highest first (alphaTab's order). */
  tuning: readonly number[];
  /** Plays a reference note. */
  onPlay: (pitch: number) => void;
  /** Opens Settings, where the audio input is chosen; focus comes back to `from`. */
  onOpenSettings?: (from: HTMLElement) => void;
}) {
  const [tab, setTab] = useState("notes");
  const [listening, setListening] = useState(false);
  const input = useAudioInput();
  const mic = useMicrophonePitch(open && tab === "mic" && listening, tuning, input);
  // Low string first, as a player tunes.
  const strings = tuning.map((pitch, i) => ({ pitch, number: i + 1 })).reverse();

  const close = (next: boolean) => {
    if (!next) setListening(false);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tuner: {trackName}</DialogTitle>
          <DialogDescription>
            {tuningLabel(tuning)}:{" "}
            {strings.map((s) => pitchName(s.pitch, { octave: false })).join(" ")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="notes">Reference notes</TabsTrigger>
              <TabsTrigger value="mic">Microphone</TabsTrigger>
            </TabsList>
            <TabsContent value="notes" className="flex flex-col gap-3 pt-2">
              <p className="text-sm text-muted-foreground">
                Play a string&apos;s note and tune the string until they sound the same.
              </p>
              <ul className="flex flex-wrap gap-2" aria-label="Open strings">
                {strings.map((s) => (
                  <li key={s.number}>
                    <Button
                      variant="outline"
                      onClick={() => onPlay(s.pitch)}
                      aria-label={`Hear string ${s.number}, ${pitchName(s.pitch, { spoken: true })}`}
                    >
                      <Volume2Icon data-icon="inline-start" />
                      {pitchName(s.pitch)}
                    </Button>
                  </li>
                ))}
              </ul>
            </TabsContent>
            <TabsContent value="mic" className="flex flex-col gap-3 pt-2">
              <div className="flex items-center gap-3">
                <Button
                  variant={listening ? "outline" : "default"}
                  onClick={() => setListening((on) => !on)}
                >
                  {listening ? (
                    <MicOffIcon data-icon="inline-start" />
                  ) : (
                    <MicIcon data-icon="inline-start" />
                  )}
                  {listening ? "Stop listening" : "Listen with the microphone"}
                </Button>
                <span role="status" className="text-sm text-muted-foreground">
                  {mic.state.kind === "off" && "The microphone is off."}
                  {mic.state.kind === "asking" && "Asking for the microphone…"}
                  {mic.state.kind === "listening" &&
                    (mic.state.device
                      ? `Listening to ${mic.state.device}. Play one string at a time.`
                      : "Listening. Play one string at a time.")}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 text-sm">
                <span>Input: {input?.label ?? "System default"}</span>
                {onOpenSettings && (
                  <Button
                    variant="link"
                    size="sm"
                    className="px-0"
                    onClick={(event) => onOpenSettings(event.currentTarget)}
                  >
                    Change input…
                  </Button>
                )}
              </div>
              {mic.state.kind === "blocked" && (
                <p className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm">
                  {mic.state.message}
                </p>
              )}
              {mic.state.kind === "listening" && (
                <>
                  <p className="text-center text-3xl font-semibold tabular-nums">
                    {mic.heard?.note ?? "–"}
                  </p>
                  <CentsMeter cents={mic.heard?.cents ?? null} />
                  {mic.heard && (
                    <p className="text-center text-sm">
                      Closest string: {mic.heard.string + 1} ({pitchName(tuning[mic.heard.string]!)}
                      )
                    </p>
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
