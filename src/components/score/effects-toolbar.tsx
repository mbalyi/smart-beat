import type { MouseEvent, ReactNode } from "react";
import { ChevronDownIcon, GuitarIcon, SplineIcon, TypeIcon } from "lucide-react";
import { model } from "@coderline/alphatab";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toggle } from "@/components/ui/toggle";
import type { EffectsInfo } from "@/lib/score/editor";
import {
  BEAT_EFFECTS,
  effectAvailable,
  effectOff,
  NOTE_EFFECTS,
  type BeatEffectId,
  type Effect,
  type NoteEffectId,
} from "@/lib/score/effects";
import type { TrackKind } from "@/lib/score/music";

const { GraceType } = model;

export interface EffectActions {
  onToggleNote: (id: NoteEffectId) => void;
  onNoteEffect: (id: NoteEffectId, value: number) => void;
  onToggleBeat: (id: BeatEffectId) => void;
  onBeatEffect: (id: BeatEffectId, value: number) => void;
  /** Grace note before or on the beat, or none (alphaTab's GraceType). */
  onGrace: (type: number) => void;
  onBend: () => void;
  onWhammy: () => void;
  onText: () => void;
  onChord: () => void;
  /** Gives focus back to the score after an action. */
  onDone: () => void;
}

/** The effects with a toggle button, and their key in the score. */
const QUICK_TOGGLES: { id: NoteEffectId; key: string }[] = [
  { id: "hammerPull", key: "H" },
  { id: "palmMute", key: "P" },
  { id: "letRing", key: "L" },
  { id: "dead", key: "X" },
  { id: "ghost", key: "O" },
  { id: "vibrato", key: "W" },
  { id: "accent", key: ">" },
  { id: "staccato", key: "" },
];

const GRACE_CHOICES = [
  { value: GraceType.None, label: "No grace note" },
  { value: GraceType.BeforeBeat, label: "Grace note before the beat" },
  { value: GraceType.OnBeat, label: "Grace note on the beat" },
];

/** A radio group in a menu, for one effect. */
function EffectRadios({
  effect,
  value,
  disabled,
  label,
  onChange,
}: {
  effect: Effect;
  value: number | undefined;
  disabled: boolean;
  label?: string;
  onChange: (value: number) => void;
}) {
  return (
    <>
      <DropdownMenuLabel>{label ?? effect.label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={value === undefined ? "" : String(value)}
        onValueChange={(v) => onChange(Number(v))}
      >
        {effect.choices.map((choice) => (
          <DropdownMenuRadioItem
            key={choice.value}
            value={String(choice.value)}
            disabled={disabled}
          >
            {choice.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** A toolbar button opening a menu of effects. */
function EffectMenu({
  label,
  active,
  onDone,
  children,
}: {
  label: string;
  /** An effect of the menu is on at the cursor. */
  active: boolean;
  onDone: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={active ? "border-sky-600 bg-sky-100 dark:bg-sky-900" : undefined}
          aria-label={active ? `${label} (on)` : label}
        >
          {label}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-auto min-w-56"
        // Typing continues in the score after a choice.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onDone();
        }}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Guitar techniques and other effects for the note (or beat) at the edit
 * cursor, or everything selected: common ones as toggles, the rest in menus,
 * plus bends, the whammy bar, text and chords. Effects that don't suit the
 * track (e.g. bends on a piano) are left out.
 */
export function EffectsToolbar({
  effects,
  kind,
  actions,
}: {
  effects: EffectsInfo;
  kind: TrackKind;
  actions: EffectActions;
}) {
  const keepFocus = (event: MouseEvent) => {
    // Clicks shouldn't move focus out of the score (typing continues there).
    const button = (event.target as Element).closest("button");
    if (button && !button.hasAttribute("aria-haspopup")) event.preventDefault();
  };
  const then =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      action(...args);
      actions.onDone();
    };
  const note = effects.note;
  const beat = effects.beat;
  const noteOn = (id: NoteEffectId) =>
    note !== null && note[id] !== effectOff(NOTE_EFFECTS[id] as Effect);
  const beatOn = (id: BeatEffectId) =>
    beat !== null && beat[id] !== effectOff(BEAT_EFFECTS[id] as Effect);
  const has = (effect: Effect) => effectAvailable(effect, kind);
  const stringed = kind === "stringed";
  const drums = kind === "drums";

  return (
    <div
      role="toolbar"
      aria-label="Effects"
      onMouseDown={keepFocus}
      className="border-b bg-sky-50/30 px-4 py-2 sm:px-6 dark:bg-sky-950/10"
    >
      <div className="-my-1 flex items-center gap-x-3 gap-y-2 overflow-x-auto py-1 *:shrink-0 sm:flex-wrap">
        <div className="flex gap-1" role="group" aria-label="Note effects">
          {QUICK_TOGGLES.filter(({ id }) => has(NOTE_EFFECTS[id] as Effect)).map(({ id, key }) => {
            const effect = NOTE_EFFECTS[id] as Effect;
            return (
              <Toggle
                key={id}
                variant="outline"
                size="sm"
                disabled={note === null}
                pressed={noteOn(id)}
                onPressedChange={then(() => actions.onToggleNote(id))}
                aria-label={effect.label}
                title={key ? `${effect.label} (${key})` : effect.label}
                className="min-w-9"
              >
                <span aria-hidden="true">{effect.short}</span>
              </Toggle>
            );
          })}
        </div>

        {stringed && (
          <EffectMenu
            label="Slide"
            active={noteOn("slideOut") || noteOn("slideIn")}
            onDone={actions.onDone}
          >
            <EffectRadios
              effect={NOTE_EFFECTS.slideOut}
              label="Slide out (S)"
              value={note?.slideOut}
              disabled={note === null}
              onChange={(v) => actions.onNoteEffect("slideOut", v)}
            />
            <DropdownMenuSeparator />
            <EffectRadios
              effect={NOTE_EFFECTS.slideIn}
              value={note?.slideIn}
              disabled={note === null}
              onChange={(v) => actions.onNoteEffect("slideIn", v)}
            />
          </EffectMenu>
        )}

        {stringed && (
          <EffectMenu label="Harmonic" active={noteOn("harmonic")} onDone={actions.onDone}>
            <EffectRadios
              effect={NOTE_EFFECTS.harmonic}
              label="Harmonic (N: natural)"
              value={note?.harmonic}
              disabled={note === null}
              onChange={(v) => actions.onNoteEffect("harmonic", v)}
            />
          </EffectMenu>
        )}

        {!drums && (
          <EffectMenu
            label="Vibrato and trill"
            active={noteOn("vibrato") || noteOn("trill")}
            onDone={actions.onDone}
          >
            <EffectRadios
              effect={NOTE_EFFECTS.vibrato}
              value={note?.vibrato}
              disabled={note === null}
              onChange={(v) => actions.onNoteEffect("vibrato", v)}
            />
            <DropdownMenuSeparator />
            <EffectRadios
              effect={NOTE_EFFECTS.trill}
              value={note?.trill}
              disabled={note === null}
              onChange={(v) => actions.onNoteEffect("trill", v)}
            />
            <EffectRadios
              effect={NOTE_EFFECTS.trillSpeed}
              value={note?.trillSpeed}
              disabled={note === null || note.trill === 0}
              onChange={(v) => actions.onNoteEffect("trillSpeed", v)}
            />
          </EffectMenu>
        )}

        {!drums && (
          <EffectMenu
            label="Picking"
            active={
              beatOn("brush") || beatOn("tremolo") || beatOn("pickStroke") || beatOn("rasgueado")
            }
            onDone={actions.onDone}
          >
            <EffectRadios
              effect={BEAT_EFFECTS.brush}
              value={beat?.brush}
              disabled={beat === null}
              onChange={(v) => actions.onBeatEffect("brush", v)}
            />
            <DropdownMenuSeparator />
            <EffectRadios
              effect={BEAT_EFFECTS.tremolo}
              value={beat?.tremolo}
              disabled={beat === null}
              onChange={(v) => actions.onBeatEffect("tremolo", v)}
            />
            {stringed && (
              <>
                <DropdownMenuSeparator />
                <EffectRadios
                  effect={BEAT_EFFECTS.pickStroke}
                  value={beat?.pickStroke}
                  disabled={beat === null}
                  onChange={(v) => actions.onBeatEffect("pickStroke", v)}
                />
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={beat === null}>
                    Rasgueado
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                    <DropdownMenuRadioGroup
                      value={beat ? String(beat.rasgueado) : ""}
                      onValueChange={(v) => actions.onBeatEffect("rasgueado", Number(v))}
                    >
                      {BEAT_EFFECTS.rasgueado.choices.map((choice) => (
                        <DropdownMenuRadioItem key={choice.value} value={String(choice.value)}>
                          {choice.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </EffectMenu>
        )}

        <EffectMenu
          label="More"
          active={
            effects.grace !== GraceType.None ||
            noteOn("accent") ||
            noteOn("leftHandTap") ||
            beatOn("tap") ||
            beatOn("slap") ||
            beatOn("pop") ||
            beatOn("fade") ||
            beatOn("wah")
          }
          onDone={actions.onDone}
        >
          <DropdownMenuLabel>Grace note</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(effects.grace)}
            onValueChange={(v) => actions.onGrace(Number(v))}
          >
            {GRACE_CHOICES.map((choice) => (
              <DropdownMenuRadioItem
                key={choice.value}
                value={String(choice.value)}
                disabled={beat === null}
              >
                {choice.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <EffectRadios
            effect={NOTE_EFFECTS.accent}
            value={note?.accent}
            disabled={note === null}
            onChange={(v) => actions.onNoteEffect("accent", v)}
          />
          {!drums && (
            <>
              <DropdownMenuSeparator />
              <EffectRadios
                effect={BEAT_EFFECTS.fade}
                value={beat?.fade}
                disabled={beat === null}
                onChange={(v) => actions.onBeatEffect("fade", v)}
              />
            </>
          )}
          {stringed && (
            <>
              <DropdownMenuSeparator />
              <EffectRadios
                effect={BEAT_EFFECTS.wah}
                value={beat?.wah}
                disabled={beat === null}
                onChange={(v) => actions.onBeatEffect("wah", v)}
              />
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Tapping, slap and pop</DropdownMenuLabel>
              {(["tap", "slap", "pop"] as const).map((id) => (
                <DropdownMenuCheckboxItem
                  key={id}
                  checked={beatOn(id)}
                  disabled={beat === null}
                  onCheckedChange={() => actions.onToggleBeat(id)}
                >
                  {BEAT_EFFECTS[id].label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuCheckboxItem
                checked={noteOn("leftHandTap")}
                disabled={note === null}
                onCheckedChange={() => actions.onToggleNote("leftHandTap")}
              >
                {NOTE_EFFECTS.leftHandTap.label}
              </DropdownMenuCheckboxItem>
            </>
          )}
        </EffectMenu>

        <div className="flex gap-1">
          {stringed && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={note === null}
                onClick={actions.onBend}
                title="Bend (Shift+B)"
                className={effects.bend ? "border-sky-600 bg-sky-100 dark:bg-sky-900" : undefined}
              >
                <SplineIcon data-icon="inline-start" />
                Bend…
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={beat === null}
                onClick={actions.onWhammy}
                title="Whammy bar"
                className={effects.whammy ? "border-sky-600 bg-sky-100 dark:bg-sky-900" : undefined}
              >
                <GuitarIcon data-icon="inline-start" />
                Whammy…
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={actions.onText} title="Text">
            <TypeIcon data-icon="inline-start" />
            Text…
          </Button>
          <Button variant="outline" size="sm" onClick={actions.onChord} title="Chord">
            Chord…
          </Button>
        </div>
      </div>
    </div>
  );
}
