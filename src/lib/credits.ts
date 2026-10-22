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
  /** "by RustAudio": the group behind it, written next to the name. */
  by?: string;
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
    name: "RustySynth",
    url: "https://github.com/sinshu/rustysynth",
    description:
      "Turns notes and SoundFonts into sound: the software synthesizer of the audio engine.",
  },
  {
    name: "cpal",
    by: "RustAudio",
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
  {
    name: "Basic Pitch",
    url: "https://github.com/spotify/basic-pitch",
    description:
      "Listens to a recording of a guitar, bass or piano and finds the notes, for Record to tab.",
  },
  {
    name: "Transkun",
    url: "https://github.com/Yujia-Yan/Transkun",
    description:
      "The high-accuracy piano model of Record to tab, which turns piano audio into notes.",
  },
];

/**
 * An optional add-on the user downloads themselves (#150). Not part of Smart Beat and not built
 * into it: shown in its own section, apart from the libraries above. The weights are CC BY-NC 4.0,
 * for non-commercial use only. Text only, no logos: Smart Beat is independent and not affiliated
 * with or endorsed by Kyutai or Mirelo.
 */
export interface Addon extends Credit {
  /** Who made it. */
  authors: string;
  licence: { name: string; url: string };
  /** Where the terms of the weights are published. The user accepts them there. */
  modelCard: string;
  /** Converted for Smart Beat's use (no retraining) by someone else. */
  conversion: string;
  /** The paragraph under "Powered by MuScriptor". */
  about: string;
  /** More places to read about it. */
  links: readonly { label: string; url: string; note?: string }[];
}

/** The two organisations behind MuScriptor. Text only, no logos (docs/brand/README.md). */
export const MUSCRIPTOR_AUTHORS: readonly { name: string; url: string; description: string }[] = [
  {
    name: "Kyutai",
    url: "https://kyutai.org/",
    description: "A non-profit AI research lab, co-author of MuScriptor.",
  },
  {
    name: "Mirelo",
    url: "https://mirelo.ai/",
    description: "An AI audio company, co-author of MuScriptor.",
  },
];

export const MUSCRIPTOR: Addon = {
  name: "MuScriptor",
  authors: "Kyutai and Mirelo",
  url: "https://huggingface.co/MuScriptor",
  description:
    "An AI model that turns a recording of many instruments into notes. You download it once; it then runs on your computer.",
  licence: {
    name: "CC BY-NC 4.0",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
  },
  modelCard: "https://huggingface.co/MuScriptor/muscriptor-medium",
  conversion:
    "The weights are converted to GGUF (float16, no retraining) by DamRsn and run with muscriptor.cpp (MIT).",
  about:
    "MuScriptor is a multi-instrument music transcription model from Kyutai and Mirelo, trained on real recordings across many genres. Once you have downloaded it, it runs locally: your recordings never leave this computer.",
  links: [
    {
      label: "Online demo",
      url: "https://muscriptor.kyutai.org/",
      note: "runs on Kyutai's servers, not on your computer",
    },
    { label: "Paper", url: "https://arxiv.org/abs/2607.08168" },
    { label: "Announcement", url: "https://kyutai.org/blog/2026-07-10-muscriptor/" },
    { label: "Reference code", url: "https://github.com/muscriptor/muscriptor" },
    { label: "Original checkpoints", url: "https://huggingface.co/MuScriptor" },
    { label: "GGUF weights", url: "https://huggingface.co/DamRsn/muscriptor-gguf" },
    { label: "muscriptor.cpp", url: "https://github.com/DamRsn/muscriptor.cpp" },
  ],
};

/** Every address the add-on text can open. */
export const ADDON_URLS: readonly string[] = [
  ...new Set([
    MUSCRIPTOR.url,
    MUSCRIPTOR.licence.url,
    MUSCRIPTOR.modelCard,
    ...MUSCRIPTOR_AUTHORS.map((author) => author.url),
    ...MUSCRIPTOR.links.map((link) => link.url),
  ]),
];

/** Every address the "Built with" section and the add-ons can open. */
export const CREDIT_URLS: readonly string[] = [
  ALPHATAB.url,
  ALPHATAB.source,
  ...OTHER_CREDITS.map((credit) => credit.url),
  ...ADDON_URLS,
];
