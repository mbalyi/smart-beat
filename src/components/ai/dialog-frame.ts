/**
 * The frame of every dialog that takes part in the AI flow (Record to tab, Import from Audio and
 * the installer): one width and one height, whatever the dialog shows. The body scrolls inside,
 * and the close button and the footer buttons never move, so the user can click through the hand-over
 * between the dialogs without the window jumping.
 */
export const AI_DIALOG_FRAME = "h-[min(42rem,calc(100dvh-2rem))] sm:max-w-3xl";
