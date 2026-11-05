import { useId, useState, type MouseEvent } from "react";
import {
  AlignJustifyIcon,
  BetweenVerticalStartIcon,
  Columns3CogIcon,
  LinkIcon,
  Trash2Icon,
} from "lucide-react";

import { NestedTupletDialog } from "@/components/score/nested-tuplet-dialog";
import { Glyph, PaletteButton, PaletteSection } from "@/components/score/palette-button";
import type { SmuflName } from "@/lib/score/smufl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/ui/tip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { BeatInfo, ToggleState } from "@/lib/score/editor";
import { DENOMINATORS, MAX_NUMERATOR, type TimeSignature } from "@/lib/score/structure";
import {
  NOTE_VALUES,
  TUPLETS,
  tupletKey,
  tupletLabel,
  type Duration,
  type Tuplet,
} from "@/lib/score/music";

/** Radio items in the palette: the size of every other palette button, GP blue when chosen. */
const CHOICE =
  "size-8 min-w-8 overflow-hidden p-0 border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground data-[state=on]:border-sky-500 data-[state=on]:bg-sky-700 aria-pressed:bg-sky-700 dark:data-[state=on]:bg-sky-700 dark:aria-pressed:bg-sky-700 data-[state=on]:text-white data-[state=on]:hover:bg-sky-600 dark:data-[state=on]:hover:bg-sky-600";

/** The note value glyph of each duration. */
/** The tuplet menu's entry that opens the nested tuplet dialog. */
const NESTED = "nested";

const NOTE_GLYPHS: Record<number, SmuflName> = {
  1: "noteWhole",
  2: "noteHalfUp",
  4: "noteQuarterUp",
  8: "note8thUp",
  16: "note16thUp",
  32: "note32ndUp",
  64: "note64thUp",
};

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
  /** Sets the time signature from the cursor's bar on, until the next bar that changes it. */
  onTimeSignature: (time: TimeSignature) => void;
  /** Gives focus back to the score after a toolbar action. */
  onDone: () => void;
}

/**
 * The time signature of the bar at the cursor: beats per bar and the note value of a beat. Any
 * signature works (7/8, 5/4, 6/8...). It lasts until the next bar that changes it.
 */
function TimeSignatureControl({
  time,
  onChange,
}: {
  time: TimeSignature;
  onChange: (time: TimeSignature) => void;
}) {
  const [text, setText] = useState(String(time.numerator));
  const commit = () => {
    const value = Math.round(Number(text));
    const numerator = Number.isFinite(value)
      ? Math.min(MAX_NUMERATOR, Math.max(1, value))
      : time.numerator;
    setText(String(numerator));
    if (numerator !== time.numerator) onChange({ ...time, numerator });
  };
  return (
    <div className="flex items-center gap-1.5">
      <Tip label="Beats per bar">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_NUMERATOR}
          size={3}
          aria-label="Beats per bar"
          className="h-8 w-14 px-2"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      </Tip>
      <span aria-hidden="true" className="text-sm text-muted-foreground">
        /
      </span>
      <Tip label="Beat unit: the note value of one beat">
        <span className="inline-flex">
          <Select
            value={String(time.denominator)}
            onValueChange={(value) => onChange({ ...time, denominator: Number(value) })}
          >
            <SelectTrigger size="sm" aria-label="Beat unit" className="h-8 w-[4.5rem] px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DENOMINATORS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
      </Tip>
    </div>
  );
}

/**
 * Edit mode tools: voice, note value, dots, tuplets, rests, ties, beats, the
 * bar's settings, plus a status line saying where the cursor is. Buttons don't
 * take focus on click, so typing continues in the score.
 */
export function EditToolbar({
  beat,
  voice,
  status,
  message,
  actions,
  statusId,
  time,
  dots,
  tie,
  auditionNotes,
  onAuditionNotesChange,
}: {
  beat: BeatInfo;
  /** The time signature of the bar at the cursor. */
  time: TimeSignature;
  /** Dotted / double-dotted on the selection (or the cursor's beat). */
  dots: (count: 1 | 2) => ToggleState;
  /** Tied notes on the selection (or the cursor's beat). */
  tie: ToggleState;
  voice: number;
  /** Where the cursor is ("Bar 3, beat 2 of 4, string 1 (E), fret 5, Quarter"). */
  status: string;
  /** Feedback on the last command, announced to screen readers. */
  message: string;
  actions: EditActions;
  statusId: string;
  /** "Play notes while editing": hear a short preview of each entered note (#90). */
  auditionNotes: boolean;
  onAuditionNotesChange: (on: boolean) => void;
}) {
  const tupletLabelId = useId();
  const auditionId = useId();
  const [nestedOpen, setNestedOpen] = useState(false);
  // A nested (or other) ratio the list does not name is shown under its own ratio.
  const customTuplet = TUPLETS.some((t) => tupletKey(t) === tupletKey(beat.tuplet))
    ? null
    : beat.tuplet;
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

  return (
    <>
      <div
        role="toolbar"
        aria-label="Edit"
        onMouseDown={keepFocus}
        className="flex flex-col gap-3 border-b px-3 py-3"
      >
        <PaletteSection title="Voice and note value">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Voice"
            value={String(voice)}
            onValueChange={(value) => value && then(actions.onVoice)(Number(value))}
          >
            <ToggleGroupItem
              value="0"
              aria-label="Voice 1"
              title="Voice 1 (V switches)"
              className={CHOICE}
            >
              1
            </ToggleGroupItem>
            <ToggleGroupItem
              value="1"
              aria-label="Voice 2"
              title="Voice 2 (V switches)"
              className={CHOICE}
            >
              2
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={1}
            aria-label="Note value"
            className="flex-wrap"
            value={String(beat.duration)}
            onValueChange={(value) => value && then(actions.onDuration)(Number(value) as Duration)}
          >
            {NOTE_VALUES.map(({ duration, label }, i) => (
              <ToggleGroupItem
                key={duration}
                value={String(duration)}
                aria-label={label}
                title={`${label} (${i + 1})`}
                className={CHOICE}
              >
                <Glyph
                  name={NOTE_GLYPHS[duration] ?? "noteQuarterUp"}
                  className={duration === 1 ? "[translate:0_-0.05em]" : undefined}
                />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </PaletteSection>

        <PaletteSection title="Rhythm">
          <PaletteButton
            label="Dot"
            shortcut="."
            state={dots(1)}
            onClick={then(() => actions.onDots(1))}
          >
            <Glyph name="augmentationDot" className="[translate:0_-0.05em] text-[2.2rem]" />
          </PaletteButton>
          <PaletteButton label="Double dot" state={dots(2)} onClick={then(() => actions.onDots(2))}>
            <span className="flex gap-0.5">
              <Glyph name="augmentationDot" className="[translate:0_-0.05em] text-[2.2rem]" />
              <Glyph name="augmentationDot" className="[translate:0_-0.05em] text-[2.2rem]" />
            </span>
          </PaletteButton>
          <PaletteButton label="Tie" shortcut="T" state={tie} onClick={then(actions.onTie)}>
            <LinkIcon className="size-4" aria-hidden="true" />
          </PaletteButton>
          <PaletteButton label="Rest" shortcut="R" onClick={then(actions.onRest)}>
            <Glyph name="restQuarter" />
          </PaletteButton>
          <PaletteButton
            label="Fill bar with rests"
            shortcut="Shift+R"
            onClick={then(actions.onFillRests)}
          >
            <AlignJustifyIcon className="size-4" aria-hidden="true" />
          </PaletteButton>
          <Tip label="Tuplet: play 3, 5, 6… notes in the time of 2, 4 or 8">
            <span className="inline-flex" id={tupletLabelId}>
              <Select
                value={tupletKey(beat.tuplet)}
                onValueChange={(value) => {
                  if (value === NESTED) {
                    setNestedOpen(true);
                    return;
                  }
                  const tuplet = TUPLETS.find((t) => tupletKey(t) === value);
                  if (tuplet) then(actions.onTuplet)(tuplet);
                }}
              >
                <SelectTrigger size="sm" aria-label="Tuplet" className="h-8 w-[6.5rem] px-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TUPLETS.map((tuplet) => (
                    <SelectItem key={tupletKey(tuplet)} value={tupletKey(tuplet)}>
                      {tuplet.label}
                    </SelectItem>
                  ))}
                  {customTuplet && (
                    <SelectItem value={tupletKey(customTuplet)}>
                      {tupletLabel(customTuplet)}
                    </SelectItem>
                  )}
                  <SelectItem value={NESTED}>Nested…</SelectItem>
                </SelectContent>
              </Select>
            </span>
          </Tip>
        </PaletteSection>

        <PaletteSection title="Time signature">
          <TimeSignatureControl
            key={`${time.numerator}/${time.denominator}`}
            time={time}
            onChange={then(actions.onTimeSignature)}
          />
        </PaletteSection>

        <PaletteSection title="Beats and bars">
          <PaletteButton label="Insert beat" shortcut="I" onClick={then(actions.onInsertBeat)}>
            <BetweenVerticalStartIcon className="size-4" aria-hidden="true" />
          </PaletteButton>
          <PaletteButton
            label="Delete beat"
            shortcut="Shift+Delete"
            onClick={then(actions.onDeleteBeat)}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
          </PaletteButton>
          <PaletteButton label="Bar…" shortcut="⌘B" onClick={actions.onBar}>
            <Columns3CogIcon className="size-4" aria-hidden="true" />
          </PaletteButton>
        </PaletteSection>
        <label
          htmlFor={auditionId}
          className="flex items-center gap-2 text-xs"
          title="Hear a short preview when entering or changing a note."
        >
          <Switch id={auditionId} checked={auditionNotes} onCheckedChange={onAuditionNotesChange} />
          Play notes while editing
        </label>
        <p id={statusId} className="text-xs text-muted-foreground tabular-nums">
          {status}
        </p>
        <p role="status" className="sr-only">
          {message}
        </p>
      </div>
      {/* Outside the toolbar: its mouse handler must not see the dialog's clicks. */}
      <NestedTupletDialog
        open={nestedOpen}
        onOpenChange={setNestedOpen}
        onApply={actions.onTuplet}
        onCloseAutoFocus={(event) => {
          // Back to the score, not to the menu that opened the dialog.
          event.preventDefault();
          actions.onDone();
        }}
      />
    </>
  );
}
