import type { ReactNode } from "react";

import { SMUFL, type SmuflName } from "@/lib/score/smufl";
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
export function MarkText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("font-serif text-[0.7rem] leading-none font-semibold italic", className)}
    >
      {children}
    </span>
  );
}
