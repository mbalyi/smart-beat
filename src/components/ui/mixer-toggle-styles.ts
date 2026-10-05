/**
 * Pressed Mute (red) and Solo (green) use mixing-desk colours, fixed in both
 * themes, so they stand out from the strip background. Radix sets both
 * `data-state=on` and `aria-pressed`, so both are overridden.
 */
export const MUTE_PRESSED =
  "data-[state=on]:border-red-700 data-[state=on]:bg-red-700 aria-pressed:bg-red-700 data-[state=on]:text-white data-[state=on]:hover:bg-red-800 data-[state=on]:hover:text-white";
export const SOLO_PRESSED =
  "data-[state=on]:border-green-700 data-[state=on]:bg-green-700 aria-pressed:bg-green-700 data-[state=on]:text-white data-[state=on]:hover:bg-green-800 data-[state=on]:hover:text-white";
/** A practice switch that is on (Metronome, Count-in). */
export const ON_GREEN = SOLO_PRESSED;
