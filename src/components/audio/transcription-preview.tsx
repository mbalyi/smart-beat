import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NotePreview } from "@/lib/audio-transcription/preview";
import type { TranscriptionNote, TranscriptionResult } from "@/lib/audio-transcription/provider";
import { label } from "@/lib/audio-transcription/upstream/instruments";
import { errorText } from "@/lib/errors";

function PianoRoll({ notes, duration }: { notes: TranscriptionNote[]; duration: number }) {
  const min = notes.reduce((p, n) => Math.min(p, n.pitch), 127) - 2;
  const max = notes.reduce((p, n) => Math.max(p, n.pitch), 0) + 2;
  const span = Math.max(1, max - min + 1);
  const tracks = [...new Set(notes.map((n) => n.instrument ?? "Transcription"))];
  return (
    // Narrow windows scroll the roll sideways: keyboard users need to reach it.
    <div
      role="region"
      aria-label="Piano roll preview"
      tabIndex={0}
      className="overflow-auto rounded-md border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <svg
        role="img"
        aria-label="Transcribed notes by instrument"
        viewBox={`0 0 760 ${Math.max(1, tracks.length) * 120}`}
        className="w-full min-w-[38rem]"
      >
        {tracks.map((track, index) => (
          <g key={track}>
            <rect width="760" height="120" y={index * 120} className="fill-background" />
            <text x="8" y={index * 120 + 18} fontSize="12" className="fill-foreground">
              {label(track)}
            </text>
            {Array.from({ length: 5 }, (_, row) => (
              <line
                key={row}
                x1="0"
                x2="760"
                y1={index * 120 + 30 + row * 18}
                y2={index * 120 + 30 + row * 18}
                className="stroke-border"
              />
            ))}
            {notes
              .filter((n) => (n.instrument ?? "Transcription") === track)
              .map((note, i) => (
                <rect
                  key={i}
                  x={(note.start / Math.max(0.1, duration)) * 760}
                  y={index * 120 + 28 + ((max - note.pitch) / span) * 75}
                  width={Math.max(2, ((note.end - note.start) / Math.max(0.1, duration)) * 760)}
                  height="7"
                  rx="2"
                  className="fill-primary"
                />
              ))}
          </g>
        ))}
      </svg>
    </div>
  );
}
export function TranscriptionPreview({
  result,
  active,
}: {
  result: TranscriptionResult;
  active: boolean;
}) {
  const player = useRef(new NotePreview());
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [solo, setSolo] = useState<string | null>(null);
  const tracks = useMemo(
    () => [...new Set(result.notes.map((n) => n.instrument ?? "Transcription"))],
    [result],
  );
  useEffect(() => {
    const preview = player.current;
    return () => preview.stop();
  }, []);
  useEffect(() => {
    if (!active) player.current.stop();
  }, [active]);
  const stop = () => {
    player.current.stop();
    setPlaying(false);
  };
  const toggle = (values: string[], track: string) =>
    values.includes(track) ? values.filter((v) => v !== track) : [...values, track];
  const play = async () => {
    setError("");
    try {
      setPlaying(true);
      await player.current.play(
        result.notes.filter((n) => {
          const track = n.instrument ?? "Transcription";
          return !muted.includes(track) && (!solo || solo === track);
        }),
        result.durationSeconds,
        () => setPlaying(false),
      );
    } catch (cause) {
      stop();
      setError(errorText(cause));
    }
  };
  return (
    <section className="flex flex-col gap-3" aria-labelledby="transcription-preview-title">
      <h3 id="transcription-preview-title" className="font-medium">
        Generated MIDI preview
      </h3>
      <p className="text-sm text-muted-foreground">
        {result.notes.length} notes · {Math.round(result.durationSeconds)} seconds
        {result.model ? ` · ${result.model}` : ""}
      </p>
      {result.notes.length ? (
        <PianoRoll
          notes={result.notes.filter((n) => !hidden.includes(n.instrument ?? "Transcription"))}
          duration={result.durationSeconds}
        />
      ) : (
        <p>No notes to preview. You can still save or import the MIDI.</p>
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          disabled={!result.notes.length}
          onClick={() => (playing ? stop() : void play())}
        >
          {playing ? "Stop MIDI preview" : "Play MIDI preview"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Synthesized tones; instrument sounds may differ after import.
        </span>
      </div>
      <ul className="flex flex-col gap-2" aria-label="Generated instrument tracks">
        {tracks.map((track) => (
          <li key={track} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="min-w-36">{label(track)}</span>
            <label>
              <input
                type="checkbox"
                aria-label={`Show ${label(track)}`}
                checked={!hidden.includes(track)}
                onChange={() => setHidden(toggle(hidden, track))}
              />{" "}
              Show
            </label>
            <label>
              <input
                type="checkbox"
                aria-label={`Mute ${label(track)}`}
                checked={muted.includes(track)}
                onChange={() => {
                  stop();
                  setMuted(toggle(muted, track));
                }}
              />{" "}
              Mute
            </label>
            <Button
              size="sm"
              variant="outline"
              aria-pressed={solo === track}
              aria-label={`Solo ${label(track)}`}
              onClick={() => {
                stop();
                setSolo(solo === track ? null : track);
              }}
            >
              Solo
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
