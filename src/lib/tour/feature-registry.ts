/**
 * The one list of features that the guided tours, the one-time hints and the "What's new"
 * dialog are built from (#84). A feature says in which release it arrived (`since`) and, when it
 * has one, the tour that shows it. Add an entry whenever a feature is added or changed in a way
 * the user should be shown: the `implement-issues` skill asks for it.
 */
export type TourId =
  "main" | "editing" | "speed-trainer" | "effects" | "record-to-tab" | "audio-lanes";

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
    id: "practice-together-editing",
    title: "Edit the tab together",
    summary:
      "In a Practice together session everyone can now edit the same tab at the same time: a change shows up on the other computers within a moment, you see each player's cursor with their name and colour, and Undo only takes back your own edits. The host can turn editing off for guests in the session dialog. Playback and the shared clock are not disturbed by edits.",
    since: "1.3.0",
  },
  {
    id: "audio-lanes",
    title: "Audio lanes",
    summary:
      "Put several audio files on lanes next to your tracks, each in its own colour (the stem colours by default), with its own mix and effects. Move, trim, split, glue and fade clips, give each its own pitch, sync the audio to the score, record plain audio takes, and open the studio for every lane at once. Old songs with a backing file open with it on a lane.",
    since: "1.3.0",
    tour: "audio-lanes",
  },
  {
    id: "edit-palette",
    title: "A tidier edit palette",
    summary:
      "The edit palette is now a compact grid of small icons. Point at one to see its name and shortcut, and an icon with several choices (key, time signature, tempo, jumps, tuplet, slide, harmonic and more) opens a small box of them. The note you are editing gets a quiet outline instead of a big box, and the options you have switched on show in purple. Open it with Edit Mode (⌘E).",
    since: "1.3.0",
  },
  {
    id: "insert-rest",
    title: "Insert a rest before or after",
    summary:
      "In Edit mode, right-click a note and pick Insert rest before or Insert rest after, or press I or Shift+I, to move the notes along without typing the bar again. The rest is as long as the note value in the palette.",
    since: "1.3.0",
    tour: "editing",
  },
  {
    id: "repeat-count",
    title: "Choose how many times a repeat plays",
    summary:
      "The Repeat end box in the palette writes a repeat end that plays 2 to 8 times, and the score's right-click menu changes the count of one that is already there. Playback follows it, and it is saved with the file.",
    since: "1.3.0",
    tour: "editing",
  },
  {
    id: "smoother-editing",
    title: "Smoother editing",
    summary:
      "Play in Edit mode starts at the note you are on, or plays only the selection. Pasting over a selection replaces it, and adds bars when the new part is longer, so nothing after it is overwritten. Copy in one open tab and paste in another. On a drum tab, click any line to write a note on it.",
    since: "1.3.0",
  },
  {
    id: "practice-together",
    title: "Practice together",
    summary:
      "Play the same tab with someone else, in time. Open Playback › Practice Together, host a session and give the code to the others (up to ten players, same network or over the internet), or join one without having the tab: the host sends it. Press Play from anyone's side and everyone starts together, sharing the speed, loops, metronome and count-in, and the host's edits follow. Each of you hears your own sound. Find it in the Playback menu, beside Record to Tab and on the start screen.",
    since: "1.2.0",
  },
  {
    id: "cloud-share",
    title: "Share with a link, and the Cloud library",
    summary:
      "Click the share icon next to a tab or a saved stems file to copy a link to it. For a file in Google Drive, OneDrive or Dropbox the link is made at once; for a file on this computer you pick the drive and Smart Beat puts a copy there first. Stems get their own link. File › Cloud Library lists everything Smart Beat keeps in each connected drive. Dropbox needs to be connected again once to allow links.",
    since: "1.2.0",
  },
  {
    id: "stem-separation",
    title: "Stem separation",
    summary:
      "Split a song into drums, bass, vocals and more on your computer, then mute, solo, loop and slow down each part to play along. Save a separation to a file, with or without the original song, and open it again later from Open saved stems without separating again, or save it in your linked cloud folder so your drive app keeps it on your other computers. Open it from the Stem separation button on the start screen, and install or delete the engines under AI › Stem Separation Models.",
    since: "1.2.0",
  },
  {
    id: "cloud-folder",
    title: "Cloud folder",
    summary:
      "Link a folder that your cloud drive keeps in sync (Google Drive, OneDrive, Dropbox, iCloud Drive) in Help › Settings, then open and save your tabs from the Cloud tab on the welcome screen or from File › Open and Save As. If a file changed in the cloud since you opened it, Smart Beat asks before saving over it.",
    since: "1.2.0",
  },
  {
    id: "ai-transcription",
    title: "AI transcription with MuScriptor",
    summary:
      "Import from Audio now works on your computer, and Record to tab has a new AI tab. Both use MuScriptor by Kyutai and Mirelo, an optional model you download once with a guided setup, and install or delete under AI › Record to Tab Models. Non-commercial use only.",
    since: "1.1.0",
  },
  {
    id: "open-with-smart-beat",
    title: "Double-click to open",
    summary:
      "Smart Beat can be the app that opens your tab and MIDI files: double-click a Guitar Pro, MusicXML or MIDI file and it opens here.",
    since: "1.1.0",
  },
  {
    id: "count-in-metronome-settings",
    title: "Count-in and metronome settings",
    summary:
      "Pick how many beats the count-in has, and how the metronome sounds and how loud it is, in two small settings windows. Stop now takes you back to the start of the song.",
    since: "1.1.0",
  },
  {
    id: "track-notes-toggle",
    title: "Hide sections, tempo markers and texts",
    summary:
      "An eye in the Tracks header shows or hides the section names, tempo markers and texts above the bars, so the header can be as small as before.",
    since: "1.1.0",
    tour: "main",
  },
  {
    id: "stacked-tracks",
    title: "Several tracks at once",
    summary:
      "In the continuous layout, show more than one track under each other, bar-aligned, and reorder them. You still edit one track at a time.",
    since: "1.1.0",
    tour: "main",
  },
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
