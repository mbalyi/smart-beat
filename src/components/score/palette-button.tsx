import type { ReactNode } from "react";

import { Tip } from "@/components/ui/tip";
import type { ToggleState } from "@/lib/score/editor";
import { cn } from "@/lib/utils";

/**
 * SMuFL code points of the notation icons (Bravura). Checked against the
 * bundled font and alphaTab's MusicFontSymbol table.
 */
export const SMUFL = {
  noteWhole: 0xe1d2,
  noteHalfUp: 0xe1d3,
  noteQuarterUp: 0xe1d5,
  note8thUp: 0xe1d7,
  note16thUp: 0xe1d9,
  note32ndUp: 0xe1db,
  note64thUp: 0xe1dd,
  augmentationDot: 0xe1e7,
  restQuarter: 0xe4e5,
  tuplet3: 0xe883,
  accidentalFlat: 0xe260,
  accidentalNatural: 0xe261,
  accidentalSharp: 0xe262,
  dynamicPPP: 0xe52a,
  dynamicPP: 0xe52b,
  dynamicPiano: 0xe520,
  dynamicMP: 0xe52c,
  dynamicMF: 0xe52d,
  dynamicForte: 0xe522,
  dynamicFF: 0xe52f,
  dynamicFFF: 0xe530,
  dynamicCrescendoHairpin: 0xe53e,
  dynamicDiminuendoHairpin: 0xe53f,
  articAccentAbove: 0xe4a0,
  articStaccatoAbove: 0xe4a2,
  articTenutoAbove: 0xe4a4,
  articMarcatoAbove: 0xe4ac,
  fermataAbove: 0xe4c0,
  noteheadXBlack: 0xe0a9,
  noteheadParenthesisLeft: 0xe0f5,
  noteheadParenthesisRight: 0xe0f6,
  noteheadBlack: 0xe0a4,
  noteheadDiamondWhite: 0xe0dd,
  graceNoteAcciaccaturaStemUp: 0xe560,
  ornamentTrill: 0xe566,
  wiggleTrill: 0xeaa4,
  tremolo3: 0xe222,
  stringsDownBow: 0xe610,
  stringsUpBow: 0xe612,
  arpeggiatoUp: 0xe634,
  arpeggiatoDown: 0xe635,
  ottavaAlta: 0xe511,
  ottavaBassaVb: 0xe51c,
  quindicesimaAlta: 0xe515,
  quindicesimaBassaMb: 0xe51d,
  guitarFadeIn: 0xe843,
  guitarFadeOut: 0xe844,
  repeatLeft: 0xe040,
  repeatRight: 0xe041,
  segno: 0xe047,
} as const;

export type SmuflName = keyof typeof SMUFL;

/** One or more SMuFL glyphs drawn with Bravura (decorative: the button has the name). */
export function Glyph({ name, className }: { name: SmuflName | SmuflName[]; className?: string }) {
  const names = Array.isArray(name) ? name : [name];
  return (
    <span
      aria-hidden="true"
      data-glyph={names.join(" ")}
      // SMuFL glyphs sit on the baseline with a tall em box: centre them in the button.
      className={cn(
        "pointer-events-none [translate:0_0.2em] font-[Bravura] text-[1.35rem] leading-none select-none",
        className,
      )}
    >
      {names.map((n) => String.fromCodePoint(SMUFL[n])).join("")}
    </span>
  );
}

/** A mark written as text in the score (P.M., let ring, tap…), shown as styled text. */
export function MarkText({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="font-serif text-[0.7rem] leading-none font-semibold italic">
      {children}
    </span>
  );
}

/** Pressed (GP's blue), partly pressed (a selection where only some have it) or not. */
const PRESSED: Record<ToggleState, string> = {
  on: "border-sky-500 bg-sky-700 text-white hover:bg-sky-600",
  mixed:
    "border-sky-500 bg-[linear-gradient(135deg,var(--color-sky-700)_50%,transparent_50%)] text-white",
  off: "",
};

/**
 * One button of the edit palette: an icon, a tooltip with its name and
 * shortcut, and `aria-pressed` (true, false or mixed) for toggles. Every
 * button has the same size. Clicks don't take focus from the score.
 */
export function PaletteButton({
  label,
  shortcut,
  state,
  disabled,
  onClick,
  children,
  haspopup,
}: {
  label: string;
  shortcut?: string;
  /** Toggles only; actions (open a dialog, insert a beat…) leave it out. */
  state?: ToggleState;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  haspopup?: boolean;
}) {
  const pressed = state === undefined ? undefined : state === "mixed" ? "mixed" : state === "on";
  const button = (
    <button
      type="button"
      data-slot="palette-button"
      aria-label={label}
      aria-pressed={pressed}
      aria-haspopup={haspopup ? "menu" : undefined}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(event) => {
        if (!haspopup) event.preventDefault(); // typing continues in the score
      }}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        state && PRESSED[state],
      )}
    >
      {children}
    </button>
  );
  return <Tip label={shortcut ? `${label} (${shortcut})` : label}>{button}</Tip>;
}

/** A titled group of palette buttons in a dense grid. */
export function PaletteSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {/* The group is named by its title (not a heading: the palette has no outline). */}
      <div
        aria-hidden="true"
        className="text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </div>
      <div role="group" aria-label={title} className="flex flex-wrap gap-1">
        {children}
      </div>
    </div>
  );
}
