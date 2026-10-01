import { useId, type MouseEvent } from "react";
import {
  AlignJustifyIcon,
  BetweenVerticalStartIcon,
  Columns3CogIcon,
  LinkIcon,
  RemoveFormattingIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { BeatInfo } from "@/lib/score/editor";
import { NOTE_VALUES, TUPLETS, tupletKey, type Duration, type Tuplet } from "@/lib/score/music";

/** Note values as fractions (music symbols are missing from many system fonts). */
const fraction = (duration: number) => (duration === 1 ? "1" : `1/${duration}`);

export interface EditActions {
  onDuration: (duration: Duration) => void;
  onDots: (dots: 1 | 2) => void;
  onTuplet: (tuplet: Tuplet) => void;
  onRest: () => void;
  /** Fills the bar (or the selected bars) with rests of the selected note value. */
  onFillRests: () => void;
  onTie: () => void;
  onInsertBeat: () => void;
  onDeleteBeat: () => void;
  onVoice: (voice: number) => void;
  /** Opens the settings of the bar at the cursor (time, key, repeats...). */
  onBar: () => void;
  /** Gives focus back to the score after a toolbar action. */
  onDone: () => void;
}

/**
 * Edit mode tools: voice, note value, dots, tuplets, rests, ties, beats, the
 * bar's settings, plus a status line saying where the cursor is. Buttons don't
 * take focus on click, so typing continues in the score.
 */
export function EditToolbar({
  beat,
  voice,
  stringed,
  status,
  message,
  actions,
  statusId,
}: {
  beat: BeatInfo;
  voice: number;
  /** Tab track: ties apply to the note on the cursor's string. */
  stringed: boolean;
  /** Where the cursor is ("Bar 3, beat 2 of 4, string 1 (E), fret 5, Quarter"). */
  status: string;
  /** Feedback on the last command, announced to screen readers. */
  message: string;
  actions: EditActions;
  statusId: string;
}) {
  const tupletLabelId = useId();
  const keepFocus = (event: MouseEvent) => {
    // Clicks shouldn't move focus out of the score (typing continues there).
    if ((event.target as Element).closest("button:not([role=combobox])")) event.preventDefault();
  };
  const then =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      action(...args);
      actions.onDone();
    };
  const tied = beat.notes.some((note) => note.tied);

  return (
    <div
      role="toolbar"
      aria-label="Edit"
      onMouseDown={keepFocus}
      className="flex flex-col gap-2 border-b px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Voice"
          value={String(voice)}
          onValueChange={(value) => value && then(actions.onVoice)(Number(value))}
        >
          <ToggleGroupItem value="0">Voice 1</ToggleGroupItem>
          <ToggleGroupItem value="1">Voice 2</ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Note value"
          className="flex-wrap"
          value={String(beat.duration)}
          onValueChange={(value) => value && then(actions.onDuration)(Number(value) as Duration)}
        >
          {NOTE_VALUES.map(({ duration, label }) => (
            <ToggleGroupItem
              key={duration}
              value={String(duration)}
              aria-label={label}
              title={label}
              className="min-w-9 tabular-nums"
            >
              <span aria-hidden="true">{fraction(duration)}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="flex gap-1">
          <Toggle
            variant="outline"
            size="sm"
            pressed={beat.dots === 1}
            onPressedChange={then(() => actions.onDots(1))}
            title="Dotted (.)"
          >
            Dot
          </Toggle>
          <Toggle
            variant="outline"
            size="sm"
            pressed={beat.dots === 2}
            onPressedChange={then(() => actions.onDots(2))}
            title="Double dotted"
          >
            Double dot
          </Toggle>
        </div>

        <div className="flex items-center gap-2">
          <span id={tupletLabelId} className="text-sm">
            Tuplet
          </span>
          <Select
            value={tupletKey(beat.tuplet)}
            onValueChange={(value) => {
              const tuplet = TUPLETS.find((t) => tupletKey(t) === value);
              if (tuplet) then(actions.onTuplet)(tuplet);
            }}
          >
            <SelectTrigger size="sm" aria-labelledby={tupletLabelId} className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TUPLETS.map((tuplet) => (
                <SelectItem key={tupletKey(tuplet)} value={tupletKey(tuplet)}>
                  {tuplet.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-1">
          <Button variant="outline" size="sm" onClick={then(actions.onRest)} title="Rest (R)">
            <RemoveFormattingIcon data-icon="inline-start" />
            <span className="sr-only max-lg:not-sr-only">Rest</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={then(actions.onFillRests)}
            title="Fill the bar with rests of this note value (Shift+R)"
          >
            <AlignJustifyIcon data-icon="inline-start" />
            <span className="sr-only max-lg:not-sr-only">Fill bar with rests</span>
          </Button>
          <Toggle
            variant="outline"
            size="sm"
            pressed={tied}
            onPressedChange={then(actions.onTie)}
            title={stringed ? "Tie the note on this string (T)" : "Tie (T)"}
          >
            <LinkIcon data-icon="inline-start" />
            <span className="sr-only max-lg:not-sr-only">Tie</span>
          </Toggle>
        </div>

        <div className="flex gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={then(actions.onInsertBeat)}
            aria-label="Insert beat"
            title="Insert beat (I)"
          >
            <BetweenVerticalStartIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={then(actions.onDeleteBeat)}
            aria-label="Delete beat"
            title="Delete beat (Shift+Delete)"
          >
            <Trash2Icon />
          </Button>
        </div>

        <Button variant="outline" size="sm" onClick={actions.onBar} title="Bar settings (⌘B)">
          <Columns3CogIcon data-icon="inline-start" />
          <span className="sr-only max-lg:not-sr-only">Bar…</span>
        </Button>
      </div>
      <p id={statusId} className="text-xs text-muted-foreground tabular-nums">
        {status}
      </p>
      <p role="status" className="sr-only">
        {message}
      </p>
    </div>
  );
}
