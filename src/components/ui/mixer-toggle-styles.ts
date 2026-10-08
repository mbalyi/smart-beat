/**
 * A pressed toggle is filled with a solid colour and outlined by an inset ring, so the state
 * is also visible without telling the colours apart (the ring is the part that doesn't depend
 * on hue). Radix sets both `data-state=on` and `aria-pressed`, and the outline toggle has its
 * own `dark:` background, so all of those are overridden (the `dark:` ones win by being more
 * specific).
 */
// Written out in full: Tailwind finds class names by scanning the source text.
export const PRESSED_CUE =
  "data-[state=on]:inset-ring-2 data-[state=on]:inset-ring-white/40 aria-pressed:inset-ring-2 aria-pressed:inset-ring-white/40";
/** Pressed Mute (red) and Solo (green) use mixing-desk colours, fixed in both themes. */
export const MUTE_PRESSED =
  "data-[state=on]:border-red-700 data-[state=on]:bg-red-700 aria-pressed:bg-red-700 dark:data-[state=on]:bg-red-700 dark:aria-pressed:bg-red-700 data-[state=on]:text-white data-[state=on]:hover:bg-red-800 data-[state=on]:hover:text-white dark:data-[state=on]:hover:bg-red-800 " +
  PRESSED_CUE;
export const SOLO_PRESSED =
  "data-[state=on]:border-green-700 data-[state=on]:bg-green-700 aria-pressed:bg-green-700 dark:data-[state=on]:bg-green-700 dark:aria-pressed:bg-green-700 data-[state=on]:text-white data-[state=on]:hover:bg-green-800 data-[state=on]:hover:text-white dark:data-[state=on]:hover:bg-green-800 " +
  PRESSED_CUE;
/** Pressed Edit stands out in blue, the colour of the edit cursor. */
export const EDIT_PRESSED =
  "data-[state=on]:border-sky-700 data-[state=on]:bg-sky-700 aria-pressed:bg-sky-700 dark:data-[state=on]:bg-sky-700 dark:aria-pressed:bg-sky-700 data-[state=on]:text-white data-[state=on]:hover:bg-sky-800 data-[state=on]:hover:text-white dark:data-[state=on]:hover:bg-sky-800 " +
  PRESSED_CUE;
/**
 * How every other toggle looks when it is on (Loop, Metronome, Count-in, panel switches…): the
 * base style of `Toggle` and `ToggleGroupItem`, so a pressed toggle never looks like an idle
 * grey one. A toggle with its own pressed colour overrides it with the same classes.
 */
export const ON_GREEN = SOLO_PRESSED;
