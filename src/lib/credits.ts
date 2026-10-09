/**
 * The open-source projects Smart Beat is built on, shown on the start page ("Built with").
 * Every URL must also be allowed in `src-tauri/capabilities/default.json` (opener:allow-open-url):
 * the app only opens the addresses listed there (checked in credits.test.ts).
 */
export interface Credit {
  name: string;
  url: string;
  what: string;
}

export const ALPHATAB = {
  name: "alphaTab",
  url: "https://alphatab.net/",
  source: "https://github.com/CoderLine/alphaTab",
} as const;

export const OTHER_CREDITS: readonly Credit[] = [
  { name: "Tauri", url: "https://tauri.app/", what: "the desktop shell" },
  { name: "React", url: "https://react.dev/", what: "the interface" },
  { name: "Vite", url: "https://vite.dev/", what: "the build tool" },
  { name: "Tailwind CSS", url: "https://tailwindcss.com/", what: "styling" },
  { name: "shadcn/ui", url: "https://ui.shadcn.com/", what: "components" },
  { name: "Radix UI", url: "https://www.radix-ui.com/", what: "accessible primitives" },
  { name: "Lucide", url: "https://lucide.dev/", what: "icons" },
  { name: "rustysynth", url: "https://github.com/sinshu/rustysynth", what: "SoundFont synthesis" },
  { name: "cpal", url: "https://github.com/RustAudio/cpal", what: "audio output" },
  { name: "Symphonia", url: "https://github.com/pdeljanov/Symphonia", what: "audio decoding" },
  { name: "nam-rs", url: "https://crates.io/crates/nam-rs", what: "amp capture playback" },
];

/** Every address the "Built with" section can open. */
export const CREDIT_URLS: readonly string[] = [
  ALPHATAB.url,
  ALPHATAB.source,
  ...OTHER_CREDITS.map((credit) => credit.url),
];
