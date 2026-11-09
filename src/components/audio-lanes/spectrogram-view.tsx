import { useEffect, useRef, useState } from "react";

import { activeTake } from "@/lib/audio-lanes/model";
import { errorText } from "@/lib/errors";
import { audioLoudness, audioSpectrogram, type AudioClip, type Loudness } from "@/lib/tauri";

const COLUMNS = 320;
const BINS = 96;

/** dB (−100 … 0) to a colour from deep blue through magenta to yellow. */
function heat(db: number): string {
  const t = Math.min(1, Math.max(0, (db + 90) / 90));
  const hue = 260 - t * 200;
  return `oklch(${0.18 + t * 0.72} ${0.08 + t * 0.14} ${hue})`;
}

/**
 * The spectrogram of the selected clip (low notes at the bottom) and its loudness: integrated and
 * loudest short-term LUFS, and the peak.
 */
export function SpectrogramView({ clip }: { clip: AudioClip }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loudness, setLoudness] = useState<Loudness | null>(null);
  const take = activeTake(clip);

  useEffect(() => {
    let cancelled = false;
    const from = take.offsetMs;
    const to = take.offsetMs + clip.lengthMs;
    setError(null);
    void audioSpectrogram(take.sourceId, from, to, COLUMNS, BINS)
      .then((columns) => {
        const ctx = canvas.current?.getContext("2d");
        if (cancelled || !ctx) return;
        columns.forEach((bins, x) =>
          bins.forEach((db, y) => {
            ctx.fillStyle = heat(db);
            ctx.fillRect(x, BINS - 1 - y, 1, 1);
          }),
        );
      })
      .catch((e: unknown) => !cancelled && setError(errorText(e)));
    void audioLoudness(take.sourceId, from, to)
      .then((l) => !cancelled && setLoudness(l))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [take.sourceId, take.offsetMs, clip.lengthMs]);

  const lufs = (v: number) => (v <= -70 ? "silent" : `${v.toFixed(1)} LUFS`);
  return (
    <section
      aria-label="Spectrogram and loudness"
      data-testid="spectrogram"
      className="flex h-40 shrink-0 gap-3 border-t bg-card p-2"
    >
      {error ? (
        <p className="m-auto text-sm text-muted-foreground">
          The spectrogram could not be drawn: {error}
        </p>
      ) : (
        <canvas
          ref={canvas}
          width={COLUMNS}
          height={BINS}
          role="img"
          aria-label={`Spectrogram of ${take.name}`}
          className="h-full min-w-0 flex-1 rounded [image-rendering:pixelated]"
        />
      )}
      <dl
        className="grid w-44 shrink-0 grid-cols-[auto_1fr] content-start gap-x-2 gap-y-1 text-sm"
        data-testid="loudness"
      >
        <dt className="text-muted-foreground">Integrated</dt>
        <dd className="tabular-nums">{loudness ? lufs(loudness.integrated) : "…"}</dd>
        <dt className="text-muted-foreground">Short-term max</dt>
        <dd className="tabular-nums">{loudness ? lufs(loudness.shortTermMax) : "…"}</dd>
        <dt className="text-muted-foreground">Peak</dt>
        <dd className="tabular-nums">{loudness ? `${loudness.peakDb.toFixed(1)} dBFS` : "…"}</dd>
      </dl>
    </section>
  );
}
