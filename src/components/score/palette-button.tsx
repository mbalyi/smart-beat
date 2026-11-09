import { useRef, type CSSProperties, type ReactNode } from "react";

import { useInkCentring } from "@/components/score/use-ink-centring";
import { SMUFL, type SmuflName } from "@/lib/score/smufl";
import { inkCentring } from "@/lib/score/smufl-ink";
import { cn } from "@/lib/utils";

/** One or more SMuFL glyphs drawn with Bravura (decorative: the button has the name). */
export function Glyph({
  name,
  className,
}: {
  name: SmuflName | readonly SmuflName[];
  className?: string;
}) {
  const names: readonly SmuflName[] = typeof name === "string" ? [name] : name;
  return (
    <span
      aria-hidden="true"
      data-glyph={names.join(" ")}
      // SMuFL glyphs sit on the baseline of a tall em box. `--glyph-shift` (em) moves the middle
      // of the ink to the middle of the cell, whatever the glyph's height; a class can override it.
      style={{ "--glyph-shift": `${inkCentring(names)}em` } as CSSProperties}
      className={cn(
        "pointer-events-none [translate:0_var(--glyph-shift)] font-[Bravura] text-[1.35rem] leading-none select-none",
        className,
      )}
    >
      {names.map((n) => String.fromCodePoint(SMUFL[n])).join("")}
    </span>
  );
}

/** A mark written as text in the score (P.M., let ring, tap…), shown as styled text. */
export function MarkText({
  children,
  className,
  centre = true,
}: {
  children: ReactNode;
  className?: string;
  /** Move the letters so their ink is centred in the button (not for a mark inside a stack). */
  centre?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useInkCentring(ref, typeof children === "string" ? children : "", centre);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn("font-serif text-[0.7rem] leading-none font-semibold italic", className)}
    >
      {children}
    </span>
  );
}
