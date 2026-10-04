import type { ReactNode } from "react";

import { Tip } from "@/components/ui/tip";
import type { ToggleState } from "@/lib/score/editor";
import { SMUFL, type SmuflName } from "@/lib/score/smufl";
import { cn } from "@/lib/utils";

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
