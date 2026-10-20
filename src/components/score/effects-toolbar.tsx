import type { MouseEvent, ReactNode } from "react";
import { Grid3x3Icon, GuitarIcon, MicVocalIcon, SplineIcon, TypeIcon } from "lucide-react";
import { model } from "@coderline/alphatab";

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
import { Glyph, MarkText, PaletteButton, PaletteSection } from "@/components/score/palette-button";
import type { SmuflName } from "@/lib/score/smufl";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import type { EffectsInfo, ToggleState } from "@/lib/score/editor";
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

const {
  AccentuationType,
  BrushType,
  CrescendoType,
  DynamicValue,
  FadeType,
  GraceType,
  NoteAccidentalMode,
  Ottavia,
  PickStroke,
} = model;

export interface EffectActions {
  onToggleNote: (id: NoteEffectId) => void;
  onNoteEffect: (id: NoteEffectId, value: number) => void;
  onToggleBeat: (id: BeatEffectId) => void;
  onBeatEffect: (id: BeatEffectId, value: number) => void;
  /** Grace note before or on the beat, or none (alphaTab's GraceType). */
  onGrace: (type: number) => void;
  onFermata: () => void;
  onRepeat: (side: "start" | "end") => void;
  onBend: () => void;
  onWhammy: () => void;
  onText: () => void;
  onChord: () => void;
  onLyrics: () => void;
  /** Gives focus back to the score after an action. */
  onDone: () => void;
}

/** What the palette shows as pressed: computed from the selection (or the cursor). */
export interface PaletteState {
  effect: (scope: "note" | "beat", id: string, value?: number) => ToggleState;
  fermata: ToggleState;
  repeatStart: boolean;
  repeatEnd: boolean;
}

const onOff = (on: boolean): ToggleState => (on ? "on" : "off");

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

/** A palette button opening a menu with every variant of some effects. */
function EffectMenu({
  label,
  icon,
  active,
  onDone,
  children,
}: {
  label: string;
  icon: ReactNode;
  /** An effect of the menu is on at the cursor. */
  active: boolean;
  onDone: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu modal={false}>
      <Tip label={label}>
        <DropdownMenuTrigger
          aria-label={active ? `${label} (on)` : label}
          data-slot="palette-button"
          className={cn(
            "relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
            active && "border-sky-500 bg-sky-700 text-white hover:bg-sky-600",
          )}
        >
          {icon}
          {/* A corner mark says the button opens a menu of variants. */}
          <span
            aria-hidden="true"
            className="absolute right-0.5 bottom-0.5 size-1.5 bg-current opacity-70 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
          />
        </DropdownMenuTrigger>
      </Tip>
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

/** An exclusive choice of one effect as one button per value (dynamics, accidentals…). */
interface ChoiceButton {
  value: number;
  label: string;
  icon: ReactNode;
  shortcut?: string;
}

/** Articulations are small glyphs drawn above the note: bigger, and moved down to the middle. */
const ARTIC = "text-[2.2rem] [translate:0_0.27em]";

const glyph = (name: SmuflName | SmuflName[], className?: string) => (
  <Glyph name={name} className={className} />
);

const DYNAMICS: ChoiceButton[] = [
  { value: DynamicValue.PPP, label: "Pianississimo (ppp)", icon: glyph("dynamicPPP") },
  { value: DynamicValue.PP, label: "Pianissimo (pp)", icon: glyph("dynamicPP") },
  { value: DynamicValue.P, label: "Piano (p)", icon: glyph("dynamicPiano") },
  { value: DynamicValue.MP, label: "Mezzo-piano (mp)", icon: glyph("dynamicMP") },
  { value: DynamicValue.MF, label: "Mezzo-forte (mf)", icon: glyph("dynamicMF") },
  { value: DynamicValue.F, label: "Forte (f)", icon: glyph("dynamicForte") },
  { value: DynamicValue.FF, label: "Fortissimo (ff)", icon: glyph("dynamicFF") },
  { value: DynamicValue.FFF, label: "Fortississimo (fff)", icon: glyph("dynamicFFF") },
];

const ACCIDENTALS: ChoiceButton[] = [
  { value: NoteAccidentalMode.ForceSharp, label: "Sharp", icon: glyph("accidentalSharp") },
  { value: NoteAccidentalMode.ForceFlat, label: "Flat", icon: glyph("accidentalFlat") },
  { value: NoteAccidentalMode.ForceNatural, label: "Natural", icon: glyph("accidentalNatural") },
];

const OTTAVAS: ChoiceButton[] = [
  { value: Ottavia._8va, label: "8va (an octave higher)", icon: glyph("ottavaAlta", "text-base") },
  {
    value: Ottavia._8vb,
    label: "8vb (an octave lower)",
    icon: glyph("ottavaBassaVb", "text-base"),
  },
  {
    value: Ottavia._15ma,
    label: "15ma (two octaves higher)",
    icon: glyph("quindicesimaAlta", "text-base"),
  },
  {
    value: Ottavia._15mb,
    label: "15mb (two octaves lower)",
    icon: glyph("quindicesimaBassaMb", "text-base"),
  },
];

/**
 * The edit palette's modifiers, as Guitar Pro 8 shows them: a dense grid of
 * icon buttons in sections (articulations, dynamics, accidentals, techniques,
 * picking, octaves, structure). A button is pressed when the modifier is set
 * on the selected notes or beats, half-pressed ("mixed") when only some have
 * it. Variants with many values sit in menus. Modifiers that don't suit the
 * track (e.g. bends on a piano) are left out.
 */
export function EffectsToolbar({
  effects,
  state,
  kind,
  actions,
}: {
  effects: EffectsInfo;
  state: PaletteState;
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

  /** A toggle for a note effect (its usual value, or `value`). */
  const noteToggle = (
    id: NoteEffectId,
    icon: ReactNode,
    opts: { label?: string; value?: number; shortcut?: string } = {},
  ) => {
    const effect = NOTE_EFFECTS[id] as Effect;
    if (!has(effect)) return null;
    const value = opts.value;
    return (
      <PaletteButton
        key={`${id}:${value ?? "on"}`}
        label={opts.label ?? effect.label}
        shortcut={opts.shortcut}
        state={state.effect("note", id, value)}
        disabled={note === null}
        onClick={then(() =>
          value === undefined
            ? actions.onToggleNote(id)
            : actions.onNoteEffect(
                id,
                state.effect("note", id, value) === "on" ? effectOff(effect) : value,
              ),
        )}
      >
        {icon}
      </PaletteButton>
    );
  };

  /** A toggle for a beat effect (its usual value, or `value`). */
  const beatToggle = (
    id: BeatEffectId,
    icon: ReactNode,
    opts: { label?: string; value?: number; shortcut?: string } = {},
  ) => {
    const effect = BEAT_EFFECTS[id] as Effect;
    if (!has(effect)) return null;
    const value = opts.value;
    return (
      <PaletteButton
        key={`${id}:${value ?? "on"}`}
        label={opts.label ?? effect.label}
        shortcut={opts.shortcut}
        state={state.effect("beat", id, value)}
        disabled={beat === null}
        onClick={then(() =>
          value === undefined
            ? actions.onToggleBeat(id)
            : actions.onBeatEffect(
                id,
                state.effect("beat", id, value) === "on" ? effectOff(effect) : value,
              ),
        )}
      >
        {icon}
      </PaletteButton>
    );
  };

  /** Exclusive buttons for the values of one effect: exactly one pressed (the cursor's). */
  const exclusive = (scope: "note" | "beat", id: string, choices: ChoiceButton[]) => {
    const effect = (scope === "note" ? NOTE_EFFECTS : BEAT_EFFECTS)[id as never] as Effect;
    if (!has(effect)) return null;
    const current = (scope === "note" ? note : beat)?.[id as never] as number | undefined;
    const set = (value: number) =>
      scope === "note"
        ? actions.onNoteEffect(id as NoteEffectId, value)
        : actions.onBeatEffect(id as BeatEffectId, value);
    return choices.map((choice) => (
      <PaletteButton
        key={`${id}:${choice.value}`}
        label={choice.label}
        shortcut={choice.shortcut}
        state={onOff(current === choice.value)}
        disabled={current === undefined}
        onClick={then(() => set(current === choice.value ? effectOff(effect) : choice.value))}
      >
        {choice.icon}
      </PaletteButton>
    ));
  };

  return (
    <div
      role="toolbar"
      aria-label="Effects"
      onMouseDown={keepFocus}
      className="flex flex-col gap-3 border-b px-3 py-3"
    >
      <PaletteSection title="Articulations">
        {noteToggle("accent", glyph("articAccentAbove", ARTIC), { shortcut: ">" })}
        {noteToggle("accent", glyph("articMarcatoAbove", ARTIC), {
          label: "Heavy accent",
          value: AccentuationType.Heavy,
        })}
        {noteToggle("accent", glyph("articTenutoAbove", ARTIC), {
          label: "Tenuto",
          value: AccentuationType.Tenuto,
        })}
        {noteToggle("staccato", glyph("articStaccatoAbove", ARTIC))}
        <PaletteButton
          label="Fermata"
          state={state.fermata}
          disabled={beat === null}
          onClick={then(actions.onFermata)}
        >
          {glyph("fermataAbove")}
        </PaletteButton>
        {noteToggle("dead", glyph("noteheadXBlack", "text-2xl [translate:0_0.05em]"), {
          shortcut: "X",
        })}
        {noteToggle(
          "ghost",
          glyph(
            ["noteheadParenthesisLeft", "noteheadBlack", "noteheadParenthesisRight"],
            "text-2xl [translate:0_0.05em]",
          ),
          {
            shortcut: "O",
          },
        )}
      </PaletteSection>

      <PaletteSection title="Dynamics">
        {exclusive("beat", "dynamics", DYNAMICS)}
        {beatToggle("crescendo", glyph("dynamicCrescendoHairpin", "text-base"), {
          label: "Crescendo",
          value: CrescendoType.Crescendo,
        })}
        {beatToggle("crescendo", glyph("dynamicDiminuendoHairpin", "text-base"), {
          label: "Decrescendo",
          value: CrescendoType.Decrescendo,
        })}
      </PaletteSection>

      {!drums && (
        <PaletteSection title="Accidentals and octaves">
          {exclusive("note", "accidental", ACCIDENTALS)}
          {exclusive("beat", "ottava", OTTAVAS)}
        </PaletteSection>
      )}

      <PaletteSection title="Techniques">
        {noteToggle("hammerPull", <MarkText>H/P</MarkText>, { shortcut: "H" })}
        {noteToggle("palmMute", <MarkText>P.M.</MarkText>, { shortcut: "P" })}
        {noteToggle("letRing", <MarkText>let r.</MarkText>, { shortcut: "L" })}
        {noteToggle("vibrato", glyph(["wiggleTrill", "wiggleTrill", "wiggleTrill"], "text-base"), {
          shortcut: "W",
        })}
        {noteToggle("trill", glyph("ornamentTrill"))}
        <PaletteButton
          label="Grace note"
          state={onOff(effects.grace !== GraceType.None)}
          disabled={beat === null}
          onClick={then(() =>
            actions.onGrace(
              effects.grace === GraceType.None ? GraceType.BeforeBeat : GraceType.None,
            ),
          )}
        >
          {glyph("graceNoteAcciaccaturaStemUp")}
        </PaletteButton>
        {stringed && (
          <EffectMenu
            label="Slide"
            icon={<MarkText>sl.</MarkText>}
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
          <EffectMenu
            label="Harmonic"
            icon={glyph("noteheadDiamondWhite")}
            active={noteOn("harmonic")}
            onDone={actions.onDone}
          >
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
            icon={<MarkText>vib.</MarkText>}
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
        {stringed && (
          <>
            {beatToggle("tap", <MarkText>T</MarkText>, { label: "Tapping" })}
            {beatToggle("slap", <MarkText>S</MarkText>)}
            {beatToggle("pop", <MarkText>P</MarkText>)}
            {noteToggle("leftHandTap", <MarkText>LH</MarkText>)}
            <PaletteButton
              label="Bend…"
              shortcut="Shift+B"
              state={onOff(effects.bend !== null)}
              disabled={note === null}
              onClick={actions.onBend}
            >
              <SplineIcon className="size-4" aria-hidden="true" />
            </PaletteButton>
            <PaletteButton
              label="Whammy…"
              state={onOff(effects.whammy !== null)}
              disabled={beat === null}
              onClick={actions.onWhammy}
            >
              <GuitarIcon className="size-4" aria-hidden="true" />
            </PaletteButton>
          </>
        )}
      </PaletteSection>

      {!drums && (
        <PaletteSection title="Picking">
          {beatToggle("pickStroke", glyph("stringsDownBow"), {
            label: "Downstroke",
            value: PickStroke.Down,
          })}
          {beatToggle("pickStroke", glyph("stringsUpBow"), {
            label: "Upstroke",
            value: PickStroke.Up,
          })}
          {beatToggle("brush", glyph("arpeggiatoDown"), {
            label: "Arpeggio down",
            value: BrushType.ArpeggioDown,
          })}
          {beatToggle("brush", glyph("arpeggiatoUp"), {
            label: "Arpeggio up",
            value: BrushType.ArpeggioUp,
          })}
          {beatToggle("tremolo", glyph("tremolo3"), { label: "Tremolo picking" })}
          {beatToggle("fade", glyph("guitarFadeIn"), { label: "Fade in", value: FadeType.FadeIn })}
          {beatToggle("fade", glyph("guitarFadeOut"), {
            label: "Fade out",
            value: FadeType.FadeOut,
          })}
          <EffectMenu
            label="Picking"
            icon={<MarkText>pick</MarkText>}
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
        </PaletteSection>
      )}

      <PaletteSection title="Structure and text">
        <PaletteButton
          label="Repeat start"
          state={onOff(state.repeatStart)}
          onClick={then(() => actions.onRepeat("start"))}
        >
          {glyph("repeatLeft")}
        </PaletteButton>
        <PaletteButton
          label="Repeat end"
          state={onOff(state.repeatEnd)}
          onClick={then(() => actions.onRepeat("end"))}
        >
          {glyph("repeatRight")}
        </PaletteButton>
        <PaletteButton label="Text…" state={onOff(effects.text !== null)} onClick={actions.onText}>
          <TypeIcon className="size-4" aria-hidden="true" />
        </PaletteButton>
        <PaletteButton
          label="Chord…"
          state={onOff(effects.chord !== null)}
          onClick={actions.onChord}
        >
          <Grid3x3Icon className="size-4" aria-hidden="true" />
        </PaletteButton>
        {!drums && (
          <PaletteButton label="Lyrics…" onClick={actions.onLyrics}>
            <MicVocalIcon className="size-4" aria-hidden="true" />
          </PaletteButton>
        )}
        <EffectMenu
          label="More"
          icon={<MarkText>•••</MarkText>}
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
      </PaletteSection>
    </div>
  );
}
