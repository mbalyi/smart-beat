import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  StepForwardIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { PartPreviewResult } from "@/components/audio-lanes/lane-transcribe/use-part-preview";
import { ScorePreview } from "@/components/score/score-preview";
import { Button } from "@/components/ui/button";
import { placementCaption, type LanePart } from "@/lib/audio-lanes/lane-transcribe";
import { NotePreview } from "@/lib/audio-transcription/preview";
import type { ScoreTheme } from "@/lib/score/score-theme";
import { errorText } from "@/lib/errors";

/** How many covered bars one picture shows (plus one bar of what comes before). */
export const PREVIEW_BARS = 8;

/**
 * The part as it will be written: a few bars of tab or notation, what the placement does in
 * words, a play button (a small synth, not the song's player) and, where the part can be dragged
 * to the score, a grip.
 */
export function PartPreview({
  part,
  result,
  pending,
  error,
  trackName,
  theme,
  grip,
  compact = false,
}: {
  part: LanePart;
  result: PartPreviewResult | null;
  pending: boolean;
  error: string;
  /** The name of the track the part goes on (the live song's), for the caption. */
  trackName: string;
  theme: ScoreTheme;
  /** The drag handle, when the part can be dragged. */
  grip?: ReactNode;
  compact?: boolean;
}) {
  const [paged, setPaged] = useState({ key: "", page: 0 });
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState("");
  const synth = useRef(new NotePreview());
  useEffect(() => {
    const preview = synth.current;
    return () => preview.stop();
  }, []);

  // A new placement starts from its first bar again.
  const key = result ? `${result.kind}:${result.track}:${result.firstBar}:${result.lastBar}` : "";
  const page = paged.key === key ? paged.page : 0;
  const setPage = (next: number) => setPaged({ key, page: next });

  const covered = result ? result.lastBar - result.firstBar + 1 : 0;
  const pages = Math.max(1, Math.ceil(covered / PREVIEW_BARS));
  const shown = Math.min(page, pages - 1);
  const windowFirst = result ? result.firstBar + shown * PREVIEW_BARS : 0;
  const windowLast = result ? Math.min(result.lastBar, windowFirst + PREVIEW_BARS - 1) : 0;
  // One bar of what comes before, so the part is seen in its place.
  const drawFrom = Math.max(0, windowFirst - 1);
  const drawCount = windowLast - drawFrom + 1;

  const caption = useMemo(
    () =>
      result
        ? placementCaption({
            kind: result.kind,
            firstBar: result.firstBar,
            lastBar: result.lastBar,
            appended: result.appended,
            trackName,
            existingNotes: result.existingNotes,
            noteCount: part.notes.length,
          })
        : "",
    [result, trackName, part.notes.length],
  );

  const play = async () => {
    if (playing) {
      synth.current.stop();
      setPlaying(false);
      return;
    }
    setPlayError("");
    const origin = part.span.startMs / 1000;
    const notes = part.notes.map((n) => ({
      pitch: n.pitch,
      start: n.start - origin,
      end: n.end - origin,
      velocity: n.velocity,
      instrument: part.instrument === "drums" ? "drums" : undefined,
    }));
    const duration = Math.max(0.5, (part.span.endMs - part.span.startMs) / 1000);
    try {
      setPlaying(true);
      await synth.current.play(notes, duration, () => setPlaying(false));
    } catch (cause) {
      synth.current.stop();
      setPlaying(false);
      setPlayError(errorText(cause));
    }
  };

  return (
    <section
      aria-label="Preview of the sheet"
      data-testid="part-preview"
      className="flex flex-col gap-2 rounded-xl border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {grip}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={playing ? "Stop the preview" : "Play the preview"}
          onClick={() => void play()}
          disabled={part.notes.length === 0}
        >
          {playing ? (
            <PauseIcon data-icon="inline-start" aria-hidden="true" />
          ) : (
            <PlayIcon data-icon="inline-start" aria-hidden="true" />
          )}
          {playing ? "Stop" : "Play"}
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="note-count">
          {part.notes.length} {part.notes.length === 1 ? "note" : "notes"}
        </span>
        {pages > 1 && (
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Earlier bars"
              disabled={shown === 0}
              onClick={() => setPage(shown - 1)}
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {shown + 1} of {pages}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Later bars"
              disabled={shown >= pages - 1}
              onClick={() => setPage(shown + 1)}
            >
              <ChevronRightIcon aria-hidden="true" />
            </Button>
            {shown > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPage(0)}>
                <StepForwardIcon
                  data-icon="inline-start"
                  className="rotate-180"
                  aria-hidden="true"
                />
                First change
              </Button>
            )}
          </div>
        )}
      </div>
      {result && !compact && (
        <ScorePreview
          score={result.score}
          trackIndex={result.track}
          firstBar={drawFrom}
          barCount={drawCount}
          newFrom={result.firstBar}
          newTo={result.lastBar}
          theme={theme}
        />
      )}
      <p
        role="status"
        data-testid="placement-caption"
        className="text-sm"
        aria-busy={pending || undefined}
      >
        {error ? "" : pending && !result ? "Working out the sheet…" : caption}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {playError && (
        <p role="alert" className="text-sm text-destructive">
          {playError}
        </p>
      )}
      {result && result.warnings.length > 0 && (
        <p className="text-sm text-muted-foreground">{result.warnings.join(" ")}</p>
      )}
      <p className="text-xs text-muted-foreground">
        The play button uses simple tones, not the sounds of the tab.
      </p>
    </section>
  );
}
