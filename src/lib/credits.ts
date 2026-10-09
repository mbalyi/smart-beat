/**
 * The open-source projects Smart Beat is built on, shown on the start page ("Built with").
 * Every URL must also be allowed in `src-tauri/capabilities/default.json` (opener:allow-open-url):
 * the app only opens the addresses listed there (checked in credits.test.ts).
 */
export interface Credit {
  name: string;
  url: string;
  /** What exactly it does for Smart Beat (shown when hovering or focusing its tile). */
  description: string;
}

export const ALPHATAB: Credit & { source: string } = {
  name: "alphaTab",
  url: "https://alphatab.net/",
  source: "https://github.com/CoderLine/alphaTab",
  description:
    "Reads Guitar Pro files, draws the standard notation and the tablature, and drives the score, the cursor and parts of playback.",
};

export const OTHER_CREDITS: readonly Credit[] = [
  {
    name: "rustysynth",
    url: "https://github.com/sinshu/rustysynth",
    description:
      "Turns notes and SoundFonts into sound: the software synthesizer of the audio engine.",
  },
  {
    name: "cpal by RustAudio",
    url: "https://github.com/RustAudio/cpal",
    description: "Sends the sound to your speakers or headphones on macOS, Windows and Linux.",
  },
  {
    name: "Symphonia",
    url: "https://github.com/pdeljanov/Symphonia",
    description: "Decodes audio files (MP3, WAV, FLAC, Ogg, AIFF) for the audio track.",
  },
  {
    name: "nam-rs",
    url: "https://crates.io/crates/nam-rs",
    description: "Plays Neural Amp Modeler captures, which model real guitar amplifiers.",
  },
];

/** Every address the "Built with" section can open. */
export const CREDIT_URLS: readonly string[] = [
  ALPHATAB.url,
  ALPHATAB.source,
  ...OTHER_CREDITS.map((credit) => credit.url),
];
