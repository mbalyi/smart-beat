import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_LYRIC_LINES, syllableCount, type LyricLine } from "@/lib/score/lyrics";

/** A lyric line being edited; the start bar is kept as typed (1-based). */
interface LineDraft {
  start: string;
  text: string;
}

/** One lyric line: where it starts, and its text. */
function LineFields({
  index,
  line,
  barCount,
  onChange,
}: {
  index: number;
  line: LineDraft;
  barCount: number;
  onChange: (line: LineDraft) => void;
}) {
  const textId = useId();
  const barId = useId();
  const countId = useId();
  const count = syllableCount(line.text);
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-semibold">Line {index + 1}</legend>
      <div className="flex items-center gap-2">
        <label htmlFor={barId} className="text-sm">
          Starts at bar
        </label>
        <Input
          id={barId}
          type="number"
          inputMode="numeric"
          min={1}
          max={barCount}
          required
          className="h-8 w-20"
          value={line.start}
          onChange={(e) => onChange({ ...line, start: e.target.value })}
        />
      </div>
      <label htmlFor={textId} className="sr-only">
        Line {index + 1} text
      </label>
      <Textarea
        id={textId}
        rows={2}
        value={line.text}
        placeholder={index === 0 ? "Sing a-long with the tune+we know" : undefined}
        aria-describedby={countId}
        onChange={(e) => onChange({ ...line, text: e.target.value })}
      />
      <p id={countId} className="text-xs text-muted-foreground">
        {count === 0 ? "Empty" : `${count} ${count === 1 ? "syllable" : "syllables"}`}
      </p>
    </fieldset>
  );
}

function LyricsForm({
  trackName,
  initial,
  barCount,
  onSubmit,
  onCancel,
}: {
  trackName: string;
  initial: LyricLine[];
  barCount: number;
  onSubmit: (lines: LyricLine[]) => void;
  onCancel: () => void;
}) {
  const [lines, setLines] = useState<LineDraft[]>(() =>
    Array.from({ length: MAX_LYRIC_LINES }, (_, i) => ({
      start: String((initial[i]?.startBar ?? 0) + 1),
      text: initial[i]?.text ?? "",
    })),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(
      lines.map(({ start, text }) => ({
        startBar: Math.min(barCount, Math.max(1, Math.round(Number(start)) || 1)) - 1,
        text,
      })),
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Lyrics: {trackName}</DialogTitle>
        <DialogDescription>
          Each syllable goes on the next note of voice 1 (rests are skipped). Separate syllables
          with spaces or hyphens (“Hel-lo”), join words on one note with + (“of+the”), skip a note
          with an extra space, and put comments in [brackets].
        </DialogDescription>
      </DialogHeader>
      {lines.map((line, i) => (
        <LineFields
          key={i}
          index={i}
          line={line}
          barCount={barCount}
          onChange={(next) => setLines((all) => all.map((l, j) => (j === i ? next : l)))}
        />
      ))}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Apply</Button>
      </DialogFooter>
    </form>
  );
}

/** Up to five lines of lyrics for a track, sung on its notes. */
export function LyricsDialog({
  open,
  onOpenChange,
  trackName,
  initial,
  barCount,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackName: string;
  initial: LyricLine[];
  barCount: number;
  onSubmit: (lines: LyricLine[]) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <LyricsForm
          trackName={trackName}
          initial={initial}
          barCount={barCount}
          onSubmit={(lines) => {
            onSubmit(lines);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
