import { PauseIcon, PlayIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { decodeOriginal, NotePreview } from "@/lib/audio-transcription/preview";
import type { TranscriptionNote, TranscriptionResult } from "@/lib/audio-transcription/provider";
import { label } from "@/lib/audio-transcription/upstream/instruments";
import { errorText } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** Pixels of the roll per second of music. */
const PIXELS_PER_SECOND = 24;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
const trackOf = (note: TranscriptionNote) => note.instrument ?? "Transcription";
const clock = (seconds: number) => {
  const tenths = Math.floor(seconds * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
};
const ruler = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, "0")}`;

/** The notes of every shown instrument, one lane each. Memoized: the playhead never repaints it. */
const Lanes = memo(function Lanes({
  notes,
  tracks,
  duration,
}: {
  notes: TranscriptionNote[];
  tracks: string[];
  duration: number;
}) {
  const total = Math.max(0.1, duration);
  return (
    <div role="img" aria-label="Transcribed notes by instrument">
      {tracks.map((track) => {
        const own = notes.filter((n) => trackOf(n) === track);
        const min = own.reduce((p, n) => Math.min(p, n.pitch), 127) - 1;
        const max = own.reduce((p, n) => Math.max(p, n.pitch), 0) + 1;
        const span = Math.max(1, max - min);
        return (
          <div key={track} className="relative h-16 border-t">
            <span className="sticky left-0 z-10 inline-block rounded-br-md bg-card/80 px-2 py-0.5 text-xs font-medium">
              {label(track)}
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 1000 100"
              preserveAspectRatio="none"
              className="absolute inset-x-0 top-5 bottom-1 h-[calc(100%-1.5rem)] w-full"
            >
              {own.map((note, i) => (
                <rect
                  key={i}
                  x={(note.start / total) * 1000}
                  y={((max - note.pitch) / span) * 92}
                  width={Math.max(2, ((note.end - note.start) / total) * 1000)}
                  height="8"
                  rx="2"
                  className="fill-primary"
                />
              ))}
            </svg>
          </div>
        );
      })}
    </div>
  );
});

export function TranscriptionPreview({
  result,
  active,
  file,
  onEdit,
}: {
  result: TranscriptionResult;
  active: boolean;
  /** The recording, to play it together with the MIDI. */
  file?: File | null;
  onEdit?: () => void;
}) {
  const player = useRef(new NotePreview());
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [solo, setSolo] = useState<string | null>(null);
  const [mix, setMix] = useState(0.5);
  const [stereo, setStereo] = useState(false);
  const [follow, setFollow] = useState(true);
  // undefined: decoding; null: the recording cannot be decoded.
  const [original, setOriginal] = useState<AudioBuffer | null | undefined>(file ? undefined : null);
  const [tenths, setTenths] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const at = useRef(0);
  const live = useRef({ playing: false, mix, stereo, follow });
  useEffect(() => {
    live.current = { playing, mix, stereo, follow };
  });
  const duration = Math.max(0.1, result.durationSeconds);

  const tracks = useMemo(() => [...new Set(result.notes.map(trackOf))], [result]);
  const shown = useMemo(() => tracks.filter((track) => !hidden.includes(track)), [tracks, hidden]);
  const shownNotes = useMemo(
    () => result.notes.filter((n) => !hidden.includes(trackOf(n))),
    [result, hidden],
  );
  const audible = useMemo(
    () => result.notes.filter((n) => !muted.includes(trackOf(n)) && (!solo || solo === trackOf(n))),
    [result, muted, solo],
  );
  const audibleRef = useRef(audible);
  useEffect(() => {
    audibleRef.current = audible;
  }, [audible]);

  useEffect(() => {
    const preview = player.current;
    return () => preview.stop();
  }, []);
  useEffect(() => {
    if (!active) {
      player.current.stop();
    }
  }, [active]);
  useEffect(() => {
    if (!file) return;
    let alive = true;
    void decodeOriginal(file).then((buffer) => {
      if (alive) setOriginal(buffer);
    });
    return () => {
      alive = false;
    };
  }, [file]);

  const place = useCallback(
    (seconds: number) => {
      at.current = seconds;
      const box = playhead.current;
      if (box) box.style.left = `${Math.min(100, (seconds / duration) * 100)}%`;
      setTenths(Math.floor(seconds * 10));
      const view = scroller.current;
      if (view && live.current.follow && live.current.playing && box) {
        const x = box.offsetLeft;
        if (x < view.scrollLeft || x > view.scrollLeft + view.clientWidth - 24) {
          view.scrollLeft = Math.max(0, x - view.clientWidth / 4);
        }
      }
    },
    [duration],
  );
  // The playhead follows the audio clock; React hears of it only every tenth of a second.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      place(Math.min(duration, player.current.position()));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, place]);

  const begin = useCallback(
    async (from: number) => {
      setError("");
      try {
        setPlaying(true);
        place(from);
        await player.current.play(
          audibleRef.current,
          duration,
          () => {
            setPlaying(false);
            place(0);
          },
          { original, mix: live.current.mix, stereo: live.current.stereo, from },
        );
      } catch (cause) {
        player.current.stop();
        setPlaying(false);
        setError(errorText(cause));
      }
    },
    [duration, original, place],
  );
  const stop = () => {
    at.current = player.current.position();
    player.current.stop();
    setPlaying(false);
  };
  const seek = (seconds: number) => {
    const next = Math.min(duration, Math.max(0, seconds));
    if (live.current.playing) void begin(next);
    else place(next);
  };
  // Muting or soloing while playing carries on from where the playhead is.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (live.current.playing) void begin(player.current.position());
    // Only a change of the audible notes restarts the audio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audible]);

  const toggle = (values: string[], track: string) =>
    values.includes(track) ? values.filter((v) => v !== track) : [...values, track];
  const seekFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - box.left) / box.width) * duration);
  };
  const step = Math.max(TICK_STEPS.find((s) => s * PIXELS_PER_SECOND >= 64) ?? 300, 1);
  const ticks = Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step);
  const canMix = Boolean(original);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="transcription-preview-title">
      <h3 id="transcription-preview-title" className="text-2xl font-bold">
        Preview generated MIDI
      </h3>
      <p className="text-sm text-muted-foreground">
        Listen to the result and adjust instruments before importing into Smart Beat.{" "}
        {result.notes.length} notes · {Math.round(result.durationSeconds)} seconds
        {result.model ? ` · ${result.model}` : ""}
      </p>
      {result.notes.length ? (
        <div
          ref={scroller}
          role="region"
          aria-label="Piano roll preview"
          className="overflow-x-auto rounded-xl border bg-card/70"
        >
          <div
            className="relative"
            style={{ width: Math.max(640, duration * PIXELS_PER_SECOND), minWidth: "100%" }}
            onPointerDown={seekFromPointer}
          >
            <div
              role="slider"
              tabIndex={0}
              aria-label="Playhead position"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.floor(tenths / 10)}
              aria-valuetext={`${clock(tenths / 10)} of ${ruler(duration)}`}
              className="relative h-6 cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onKeyDown={(event) => {
                const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!delta) return;
                event.preventDefault();
                seek((live.current.playing ? player.current.position() : at.current) + delta);
              }}
            >
              {ticks.map((t) => (
                <span
                  key={t}
                  aria-hidden="true"
                  className="absolute top-1 text-[10px] text-muted-foreground"
                  style={{ left: `${(t / duration) * 100}%`, paddingLeft: 4 }}
                >
                  {ruler(t)}
                </span>
              ))}
            </div>
            <Lanes notes={shownNotes} tracks={shown} duration={duration} />
            <div
              ref={playhead}
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 left-0 z-20 w-0.5 bg-primary shadow-[0_0_6px_var(--primary)]"
            />
          </div>
        </div>
      ) : (
        <p>No notes to preview. You can still save or import the MIDI.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card/70 px-3 py-2 text-sm">
        <Button
          variant="outline"
          size="icon"
          disabled={!result.notes.length}
          aria-label={playing ? "Stop MIDI preview" : "Play MIDI preview"}
          onClick={() => (playing ? stop() : void begin(at.current >= duration ? 0 : at.current))}
        >
          {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
          className={cn(follow && "border-primary text-primary")}
        >
          Follow playhead
        </Button>
        <span className="font-mono text-xs" aria-label="Time">
          {clock(tenths / 10)} / {clock(duration)}
        </span>
        <label className="ml-auto flex min-w-48 flex-1 items-center gap-2 text-xs">
          <span>Original</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={mix}
            disabled={!canMix}
            aria-label="Original and MIDI mix"
            className="h-1.5 min-w-0 flex-1 accent-primary"
            onChange={(event) => {
              const next = Number(event.target.value);
              setMix(next);
              live.current.mix = next;
              player.current.setMix(next);
            }}
          />
          <span>MIDI</span>
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={stereo}
            disabled={!canMix}
            className="accent-primary"
            onChange={(event) => {
              setStereo(event.target.checked);
              live.current.stereo = event.target.checked;
              player.current.setStereo(event.target.checked);
            }}
          />
          Stereo
          <span className="sr-only"> (original on the left, MIDI on the right)</span>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        {original === null && file
          ? "The original recording could not be decoded; only the MIDI will play. "
          : ""}
        Synthesized tones; instrument sounds may differ after import.
      </p>
      <div className="rounded-xl border bg-card/70 px-3 py-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Instruments detected</h4>
          {onEdit && (
            <Button variant="outline" size="sm" onClick={onEdit}>
              Edit
            </Button>
          )}
        </div>
        <ul aria-label="Generated instrument tracks" className="mt-1 flex flex-col">
          {tracks.map((track) => (
            <li
              key={track}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 border-t py-1.5 text-sm"
            >
              <span className="min-w-0 truncate">{label(track)}</span>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-primary"
                  aria-label={`Show ${label(track)}`}
                  checked={!hidden.includes(track)}
                  onChange={() => setHidden(toggle(hidden, track))}
                />
                Show
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-primary"
                  aria-label={`Mute ${label(track)}`}
                  checked={muted.includes(track)}
                  onChange={() => setMuted(toggle(muted, track))}
                />
                Mute
              </label>
              <Button
                size="sm"
                variant="outline"
                aria-pressed={solo === track}
                aria-label={`Solo ${label(track)}`}
                onClick={() => setSolo(solo === track ? null : track)}
              >
                Solo
              </Button>
            </li>
          ))}
        </ul>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
