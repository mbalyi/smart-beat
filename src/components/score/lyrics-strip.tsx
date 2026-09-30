import type { Syllable } from "@/lib/score/lyrics";
import type { Beat } from "@/lib/score/model";
import { cn } from "@/lib/utils";

/**
 * The lyrics around the current beat, one row per lyric line, with the
 * syllable being sung highlighted (during playback, or at the edit cursor).
 * alphaTab draws the lyrics in the score too, but can't highlight them there.
 * Not a live region: announcing every syllable would drown out the music.
 */
export function LyricsStrip({ lines, current }: { lines: Syllable[][]; current: Beat | null }) {
  return (
    <section
      aria-label="Lyrics"
      className="shrink-0 border-t bg-muted/40 px-4 py-1.5 text-sm sm:px-6"
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground">No lyrics here</p>
      ) : (
        lines.map((line, i) => (
          <p key={i} className="leading-relaxed">
            {line.map((syllable, j) => {
              const now = syllable.beat === current;
              return (
                <span key={j}>
                  <span
                    aria-current={now ? "true" : undefined}
                    className={cn(
                      "rounded-sm",
                      now && "bg-sky-600 px-0.5 font-medium text-white dark:bg-sky-500",
                    )}
                  >
                    {syllable.text}
                  </span>
                  {syllable.joined ? "-" : " "}
                </span>
              );
            })}
          </p>
        ))
      )}
    </section>
  );
}
