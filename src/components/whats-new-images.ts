import exportStemsLogo from "@/assets/export-stems/logo.webp";
import { FEATURES, type Feature } from "@/components/welcome-features";

/**
 * The picture of each "What's new" card. A feature with a picture of its own uses it; every other
 * feature shows the artwork of the card it belongs to on the start page (`welcome-features.ts`), so
 * every entry has a fitting image and none shows a generic one. A new entry in
 * `src/lib/tour/feature-registry.ts` needs a line here; a test fails until it has one.
 */
const OWN: Record<string, string> = {
  /** The Export stems dialog's own logo. */
  "stem-export": exportStemsLogo,
};

type HomeCard = Feature["title"];

/** The start page card each feature belongs to. */
const HOME_CARD: Record<string, HomeCard> = {
  // 1.3
  "hybrid-lanes": "Audio tracks & editing",
  "audio-lanes": "Audio tracks & editing",
  "practice-together-lanes": "Practice together",
  "practice-together-editing": "Practice together",
  "edit-palette": "Write tabs and scores",
  "insert-rest": "Write tabs and scores",
  "repeat-count": "Write tabs and scores",
  "smoother-editing": "Write tabs and scores",
  "stacked-tracks-any": "Open, play and practice",
  // 1.2
  "practice-together": "Practice together",
  "cloud-share": "Cloud sync",
  "cloud-folder": "Cloud sync",
  "stem-separation": "Stem separation",
  // 1.1
  "ai-transcription": "Audio to tab",
  "open-with-smart-beat": "Open, play and practice",
  "count-in-metronome-settings": "Learning mode",
  "track-notes-toggle": "Open, play and practice",
  "stacked-tracks": "Open, play and practice",
  // 1.0.x
  "guided-tour": "Learning mode",
  "demo-song": "Open, play and practice",
  "drum-notation": "Write tabs and scores",
  "copy-to-instrument": "Write tabs and scores",
  "record-piano-drums": "Record to tab",
  soundfonts: "Open, play and practice",
  "pan-control": "Open, play and practice",
  editing: "Write tabs and scores",
  "speed-trainer": "Learning mode",
  effects: "Open, play and practice",
  "record-to-tab": "Record to tab",
};

/** The image of a feature entry, or `undefined` for an id that has none yet. */
export function whatsNewImage(id: string): string | undefined {
  const own = OWN[id];
  if (own) return own;
  const card = HOME_CARD[id];
  return card ? FEATURES.find((f) => f.title === card)?.image : undefined;
}

/** The ids that have a picture, for the test that every registry entry is covered. */
export const WHATS_NEW_IMAGE_IDS: readonly string[] = [
  ...Object.keys(OWN),
  ...Object.keys(HOME_CARD),
];
