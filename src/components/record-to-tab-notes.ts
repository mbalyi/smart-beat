/**
 * What Record to Tab can and can't do, written once for the dialog and the welcome page.
 * The README's Record to tab cell repeats it; keep the two the same.
 */

/** The accuracy measured on GuitarSet (docs/record-to-tab-spike.md), in plain words. */
export const RECORD_TO_TAB_ACCURACY =
  "Roughly 7 of 10 notes are found (note F1 about 72%), and the right string is picked for about 64% of them.";

/** The short note under the dialog's title. */
export const RECORD_TO_TAB_BETA_NOTE = `Beta. Guitar only for now. ${RECORD_TO_TAB_ACCURACY} Review the tab and correct it.`;

/** The limits, one per line, for the welcome page. */
export const RECORD_TO_TAB_LIMITS: readonly string[] = [
  "Guitar only for now.",
  "No cloud AI: a small note-finding model runs on your computer, and Smart Beat's own rules pick the string and fret.",
  "Record inside the app, or use an existing guitar recording.",
  RECORD_TO_TAB_ACCURACY,
  "Review the tab afterwards. You will probably need to correct it by hand.",
];
