import { Fragment, useId, useState, type KeyboardEvent } from "react";
import { model } from "@coderline/alphatab";

import { NestedTupletDialog } from "@/components/score/nested-tuplet-dialog";
import {
  CellVisual,
  PaletteCell,
  VariantCell,
  type VariantCellProps,
} from "@/components/score/palette-cell";
import { TimeSignatureControl } from "@/components/score/time-signature-control";
import { Switch } from "@/components/ui/switch";
import type { BeatInfo, EffectsInfo, ToggleState } from "@/lib/score/editor";
import {
  BEAT_EFFECTS,
  effectOff,
  NOTE_EFFECTS,
  type BeatEffectId,
  type Effect,
  type NoteEffectId,
} from "@/lib/score/effects";
import {
  boxGroups,
  paletteFor,
  type PaletteAction,
  type PaletteBox,
  type PaletteGroup,
  type PaletteItem,
  type PaletteRow,
  type PaletteSection,
} from "@/lib/score/palette-model";
import {
  TUPLETS,
  tupletKey,
  tupletLabel,
  type Duration,
  type TrackKind,
  type Tuplet,
} from "@/lib/score/music";
import { timeSignatureText, type BarSettings, type TimeSignature } from "@/lib/score/structure";

const { GraceType } = model;

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
  /**
   * Changes settings of the bar at the cursor: key, time signature, tempo, triplet feel, endings
   * and jumps. Time, key and feel last until the next bar that changes them.
   */
  onBarSettings: (changes: Partial<BarSettings>) => void;
  /** Opens the keyboard shortcuts (left out of the palette when missing). */
  onShortcuts?: () => void;
  /** Gives focus back to the score after a palette action. */
  onDone: () => void;
}

export interface EffectActions {
  onToggleNote: (id: NoteEffectId) => void;
  onNoteEffect: (id: NoteEffectId, value: number) => void;
  onToggleBeat: (id: BeatEffectId) => void;
  onBeatEffect: (id: BeatEffectId, value: number) => void;
  /** Grace note before or on the beat, or none (alphaTab's GraceType). */
  onGrace: (type: number) => void;
  onFermata: () => void;
  onRepeat: (side: "start" | "end") => void;
  /** Ends a repeat at the cursor's bar that plays `count` times; 0 removes it (#228). */
  onRepeatEnd: (count: number) => void;
  onBend: () => void;
  onWhammy: () => void;
  onText: () => void;
  onChord: () => void;
  onLyrics: () => void;
}

/** What the palette shows as pressed: computed from the selection (or the cursor). */
export interface PaletteState {
  effect: (scope: "note" | "beat", id: string, value?: number) => ToggleState;
  fermata: ToggleState;
  repeatStart: boolean;
  repeatEnd: boolean;
  /** How many times the repeat ending at the cursor's bar plays (0: none). */
  repeatCount: number;
}

const SECTION = "flex flex-col gap-[3px] border-t border-sidebar-border py-2.5 first:border-t-0";
const ROW = "grid grid-cols-[repeat(8,2rem)] justify-start gap-[3px]";
/** A small header over a category of cells (decoration: the section group has the name). */
const HEADING =
  "pt-1.5 pb-0.5 text-[0.62rem] leading-none font-semibold tracking-[0.1em] text-sidebar-foreground/60 uppercase first:pt-0";

const onOff = (on: boolean): ToggleState => (on ? "on" : "off");

/** Arrow keys move between the radios of a group (the checked one is the tab stop). */
function moveRadio(event: KeyboardEvent<HTMLButtonElement>) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (step === undefined) return;
  const radios = [
    ...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      "[role=radio]:not(:disabled)",
    ) ?? []),
  ];
  const index = radios.indexOf(event.currentTarget);
  if (index < 0) return;
  event.preventDefault();
  radios[(index + step + radios.length) % radios.length]?.focus();
}

/**
 * The edit palette: icon-only cells in rows, and cells that open a box of variants. Cells are
 * pressed when the setting is on at the cursor (or on the selection; half pressed when only some
 * have it). What does not suit the track (bends on a piano, pitched marks on drums) is left out.
 * Cells don't take focus on click, so typing continues in the score.
 */
export function EditPalette({
  beat,
  bar,
  voice,
  effects,
  state,
  kind,
  dots,
  tie,
  status,
  message,
  statusId,
  edit,
  fx,
  auditionNotes,
  onAuditionNotesChange,
}: {
  beat: BeatInfo;
  /** The settings of the bar at the cursor. */
  bar: BarSettings;
  voice: number;
  effects: EffectsInfo;
  state: PaletteState;
  kind: TrackKind;
  /** Dotted / double-dotted on the selection (or the cursor's beat). */
  dots: (count: 1 | 2) => ToggleState;
  /** Tied notes on the selection (or the cursor's beat). */
  tie: ToggleState;
  /** Where the cursor is ("Bar 3, beat 2 of 4, string 1 (E), fret 5, Quarter"). */
  status: string;
  /** Feedback on the last command, announced to screen readers. */
  message: string;
  statusId: string;
  edit: EditActions;
  fx: EffectActions;
  /** "Play notes while editing": hear a short preview of each entered note (#90). */
  auditionNotes: boolean;
  onAuditionNotesChange: (on: boolean) => void;
}) {
  const auditionId = useId();
  const [nestedOpen, setNestedOpen] = useState(false);

  const note = effects.note;
  const beatEffects = effects.beat;

  // --- what is pressed and what is disabled ---

  const effectOf = (action: { id: string }, scope: "note" | "beat") =>
    (scope === "note" ? NOTE_EFFECTS : BEAT_EFFECTS)[action.id as never] as Effect;

  const stateOf = (action: PaletteAction): ToggleState | undefined => {
    switch (action.type) {
      case "duration":
        return onOff(beat.duration === action.duration);
      case "dots":
        return dots(action.count);
      case "tie":
        return tie;
      case "voice":
        return onOff(voice === action.voice);
      case "tuplet":
        return onOff(tupletKey(beat.tuplet) === tupletKey(action.tuplet));
      case "key":
        return onOff(bar.keySignature === action.signature && bar.keyType === action.keyType);
      case "time":
        return onOff(
          bar.timeSignature.numerator === action.time.numerator &&
            bar.timeSignature.denominator === action.time.denominator,
        );
      case "tempo":
        return onOff(bar.tempo?.bpm === action.tempo.bpm && bar.tempo.label === action.tempo.label);
      case "feel":
        return onOff(bar.tripletFeel === action.feel);
      case "ending":
        return onOff((bar.endings & (1 << (action.ending - 1))) !== 0);
      case "jump":
        return onOff(bar.directions.includes(action.direction));
      case "repeat":
        return onOff(action.side === "start" ? state.repeatStart : state.repeatEnd);
      case "repeatEnd":
        return onOff(state.repeatCount === action.count);
      case "noteEffect":
        return state.effect("note", action.id, action.value);
      case "beatEffect":
        return state.effect("beat", action.id, action.value);
      case "grace":
        return onOff(effects.grace === action.grace);
      case "fermata":
        return state.fermata;
      case "bend":
        return onOff(effects.bend !== null);
      case "whammy":
        return onOff(effects.whammy !== null);
      case "text":
        return onOff(effects.text !== null);
      case "chord":
        return onOff(effects.chord !== null);
      default:
        return undefined;
    }
  };

  const disabledOf = (action: PaletteAction) => {
    switch (action.type) {
      case "noteEffect":
        // The trill speed only matters on a note that trills.
        return note === null || (action.id === "trillSpeed" && note.trill === 0);
      case "beatEffect":
      case "grace":
      case "fermata":
      case "whammy":
        return beatEffects === null;
      case "bend":
        return note === null;
      default:
        return false;
    }
  };

  // --- running an action: true when it opens a dialog ---

  const run = (item: PaletteItem): boolean => {
    const { action } = item;
    switch (action.type) {
      case "duration":
        edit.onDuration(action.duration);
        return false;
      case "dots":
        edit.onDots(action.count);
        return false;
      case "rest":
        edit.onRest();
        return false;
      case "fillRests":
        edit.onFillRests();
        return false;
      case "tie":
        edit.onTie();
        return false;
      case "insertBeat":
        edit.onInsertBeat();
        return false;
      case "deleteBeat":
        edit.onDeleteBeat();
        return false;
      case "voice":
        edit.onVoice(action.voice);
        return false;
      case "tuplet":
        edit.onTuplet(action.tuplet);
        return false;
      case "nestedTuplet":
        setNestedOpen(true);
        return true;
      case "bar":
        edit.onBar();
        return true;
      case "key":
        edit.onBarSettings({ keySignature: action.signature, keyType: action.keyType });
        return false;
      case "time":
        edit.onBarSettings({ timeSignature: action.time });
        return false;
      case "tempo":
        // Pressing the tempo that is set takes the change off (the first bar keeps its tempo).
        edit.onBarSettings({ tempo: stateOf(action) === "on" ? null : action.tempo });
        return false;
      case "feel":
        edit.onBarSettings({ tripletFeel: action.feel });
        return false;
      case "ending":
        edit.onBarSettings({ endings: bar.endings ^ (1 << (action.ending - 1)) });
        return false;
      case "jump":
        edit.onBarSettings({
          directions: bar.directions.includes(action.direction)
            ? bar.directions.filter((d) => d !== action.direction)
            : [...bar.directions, action.direction],
        });
        return false;
      case "repeat":
        fx.onRepeat(action.side);
        return false;
      case "repeatEnd":
        // The count already there takes the repeat end away again.
        fx.onRepeatEnd(state.repeatCount === action.count ? 0 : action.count);
        return false;
      case "noteEffect": {
        if (action.value === undefined) {
          fx.onToggleNote(action.id);
        } else {
          // The trill speed is always set: pressing the speed that is on keeps it.
          const on =
            action.id !== "trillSpeed" && state.effect("note", action.id, action.value) === "on";
          fx.onNoteEffect(action.id, on ? effectOff(effectOf(action, "note")) : action.value);
        }
        return false;
      }
      case "beatEffect": {
        if (action.value === undefined) {
          fx.onToggleBeat(action.id);
        } else {
          const on = state.effect("beat", action.id, action.value) === "on";
          fx.onBeatEffect(action.id, on ? effectOff(effectOf(action, "beat")) : action.value);
        }
        return false;
      }
      case "grace":
        fx.onGrace(effects.grace === action.grace ? GraceType.None : action.grace);
        return false;
      case "fermata":
        fx.onFermata();
        return false;
      case "bend":
        fx.onBend();
        return true;
      case "whammy":
        fx.onWhammy();
        return true;
      case "text":
        fx.onText();
        return true;
      case "chord":
        fx.onChord();
        return true;
      case "lyrics":
        fx.onLyrics();
        return true;
      case "shortcuts":
        edit.onShortcuts?.();
        return true;
    }
  };

  /** A click on a cell: run it, and give focus back to the score unless a dialog took it. */
  const click = (item: PaletteItem) => {
    if (!run(item)) edit.onDone();
  };

  // --- boxes with something that depends on the cursor ---

  /** A tuplet ratio the list does not name (a nested one) gets its own cell in the box. */
  const withCustomTuplet = (groups: PaletteGroup[]): PaletteGroup[] => {
    const custom = TUPLETS.some((t) => tupletKey(t) === tupletKey(beat.tuplet))
      ? null
      : beat.tuplet;
    if (!custom) return groups;
    const item: PaletteItem = {
      id: `tuplet:${tupletKey(custom)}`,
      label: tupletLabel(custom),
      visual: { text: tupletKey(custom) },
      action: { type: "tuplet", tuplet: custom },
    };
    return groups.map((g) => {
      const at = g.items.findIndex((i) => i.action.type === "nestedTuplet");
      return at < 0 ? g : { ...g, items: [...g.items.slice(0, at), item, ...g.items.slice(at)] };
    });
  };

  const renderBox = (box: PaletteBox) => {
    let groups = boxGroups(box, kind);
    if (box.id === "tuplet") groups = withCustomTuplet(groups);
    if (groups.length === 0) return null;
    const time: TimeSignature = bar.timeSignature;
    const props: VariantCellProps = {
      box,
      groups,
      stateOf: (item) => stateOf(item.action) ?? "off",
      isDisabled: (item) => disabledOf(item.action),
      onPick: run,
      onDone: edit.onDone,
      shown:
        box.id === "time"
          ? {
              visual: { digits: [time.numerator, time.denominator] },
              label: timeSignatureText(time),
            }
          : undefined,
      footer:
        box.footer === "time"
          ? (done) => (
              <TimeSignatureControl
                key={timeSignatureText(time)}
                time={time}
                onChange={(next) => {
                  edit.onBarSettings({ timeSignature: next });
                  done();
                }}
              />
            )
          : undefined,
    };
    // The editing tour points at the repeat count box (#228).
    if (box.id === "repeat-end") return <VariantCell key={box.id} {...props} tour="repeat-end" />;
    return <VariantCell key={box.id} {...props} />;
  };

  const renderRow = (row: PaletteRow, key: number) => {
    const radio = row.radioLabel !== undefined;
    // The checked radio is the tab stop of its group (the first one when none is checked).
    const checkedAt = row.entries.findIndex((e) => "cell" in e && stateOf(e.cell.action) === "on");
    const cells = row.entries.map((entry, index) => {
      if ("box" in entry) return renderBox(entry.box);
      const item = entry.cell;
      if (item.action.type === "shortcuts" && !edit.onShortcuts) return null;
      const state = stateOf(item.action);
      return (
        <PaletteCell
          key={item.id}
          label={item.label}
          mark={item.mark}
          shortcut={item.shortcut}
          state={radio ? undefined : state}
          checked={radio ? state === "on" : undefined}
          tabIndex={radio ? (index === Math.max(0, checkedAt) ? 0 : -1) : undefined}
          disabled={disabledOf(item.action)}
          onClick={() => click(item)}
          onKeyDown={radio ? moveRadio : undefined}
        >
          <CellVisual visual={item.visual} />
        </PaletteCell>
      );
    });
    const cellRow = radio ? (
      <div role="radiogroup" aria-label={row.radioLabel} className={ROW}>
        {cells}
      </div>
    ) : (
      <div className={ROW}>{cells}</div>
    );
    return (
      <Fragment key={key}>
        {row.heading && (
          <div aria-hidden="true" data-palette-heading className={HEADING}>
            {row.heading}
          </div>
        )}
        {cellRow}
      </Fragment>
    );
  };

  const renderSection = (section: PaletteSection) => (
    <div key={section.id} role="group" aria-label={section.label} className={SECTION}>
      {section.rows.map(renderRow)}
    </div>
  );

  const sections = paletteFor(kind);
  const toolbar = (name: "Edit" | "Effects") => {
    const own = sections.filter((s) => s.toolbar === name);
    if (own.length === 0) return null;
    return (
      <div
        role="toolbar"
        aria-label={name}
        className="flex flex-col border-b border-sidebar-border px-4 py-1"
      >
        {own.map(renderSection)}
      </div>
    );
  };

  return (
    <>
      {toolbar("Edit")}
      {toolbar("Effects")}
      <div className="flex flex-col gap-2 px-4 py-3">
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
      {/* Outside the toolbars: their mouse handler must not see the dialog's clicks. */}
      <NestedTupletDialog
        open={nestedOpen}
        onOpenChange={setNestedOpen}
        onApply={edit.onTuplet}
        onCloseAutoFocus={(event) => {
          // Back to the score, not to the cell that opened the dialog.
          event.preventDefault();
          edit.onDone();
        }}
      />
    </>
  );
}
