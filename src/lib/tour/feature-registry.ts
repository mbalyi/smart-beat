/**
 * The one list of features that the guided tours, the one-time hints and the "What's new"
 * dialog are built from (#84). A feature says in which release it arrived (`since`) and, when it
 * has one, the tour that shows it. Add an entry whenever a feature is added or changed in a way
 * the user should be shown: the `implement-issues` skill asks for it.
 */
export type TourId = "main" | "editing" | "speed-trainer" | "effects" | "record-to-tab";

export interface FeatureEntry {
  id: string;
  title: string;
  /** One sentence for the "What's new" list. */
  summary: string;
  /** The release that brings it, as `major.minor.patch`. */
  since: string;
  /** The tour that shows it ("Show me" in What's new). */
  tour?: TourId;
}

export const FEATURE_REGISTRY: readonly FeatureEntry[] = [
  {
    id: "guided-tour",
    title: "A guided tour",
    summary:
      "A short tour takes you from opening a song to playing and practising it. Replay it any time from Help › Take the Tour.",
    since: "1.0.1",
    tour: "main",
  },
  {
    id: "demo-song",
    title: "A demo song",
    summary:
      "An original song with drums, guitar, bass and piano to try every feature on, from Help › Open Demo Song.",
    since: "1.0.1",
    tour: "main",
  },
  {
    id: "drum-notation",
    title: "Readable drum notation",
    summary:
      "Normalize drum notation re-maps drum notes to a readable staff layout, from the track menu or the inspector.",
    since: "1.0.1",
    tour: "editing",
  },
  {
    id: "copy-to-instrument",
    title: "Copy a track to another instrument",
    summary: "Copy a track to a different instrument, for example a guitar riff to piano.",
    since: "1.0.1",
    tour: "editing",
  },
  {
    id: "record-piano-drums",
    title: "Record piano and drums to tab",
    summary: "Record piano to staves and drums to a drum track, next to guitar and bass.",
    since: "1.0.1",
    tour: "record-to-tab",
  },
  {
    id: "soundfonts",
    title: "More instrument sounds",
    summary:
      "Import your own SoundFont or download a recommended one, then pick it under Instrument sounds. Added SoundFonts can be removed again.",
    since: "1.0.1",
    tour: "main",
  },
  {
    id: "pan-control",
    title: "Pan control",
    summary: "Pan each track left or right; double-click the control to centre it.",
    since: "1.0.1",
    tour: "effects",
  },
  {
    id: "editing",
    title: "Write notes and drums",
    summary: "Edit mode, the note palette and the drum element picker.",
    since: "1.0.0",
    tour: "editing",
  },
  {
    id: "speed-trainer",
    title: "Speed Trainer",
    summary: "Loop a passage and speed it up a little each time round.",
    since: "1.0.0",
    tour: "speed-trainer",
  },
  {
    id: "effects",
    title: "Effects and the pedalboard",
    summary: "Guitar effects per track, a pedalboard and a mastering strip.",
    since: "1.0.0",
    tour: "effects",
  },
  {
    id: "record-to-tab",
    title: "Record to tab",
    summary: "Record yourself and get tab you can edit (beta).",
    since: "1.0.0",
    tour: "record-to-tab",
  },
];
