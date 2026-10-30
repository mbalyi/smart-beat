import type { StemEngine, StemKindId } from "@/lib/tauri";

/** The name of each part, as the dialog and the page say it. */
export const STEM_LABELS: Record<StemKindId, string> = {
  drums: "Drums",
  bass: "Bass",
  vocals: "Vocals",
  panned: "Guitars and keys",
  other: "Other",
};

/** What a part is, in plain words (the dialog's list). */
export const STEM_HINTS: Record<StemKindId, string> = {
  drums: "Kick, snare and cymbals.",
  bass: "The low line of the bass guitar.",
  vocals: "The voice in the middle of the mix.",
  panned: "Guitars and keys that sit hard to the left or right.",
  other: "Everything that is not pulled out above.",
};

/** What each part cannot do, shown under it on the page. */
export function stemLimit(kind: StemKindId, engine: StemEngine): string {
  switch (kind) {
    case "drums":
      return "Faint cymbals and snare body can remain.";
    case "bass":
      return "A guitar playing the same notes can leak in.";
    case "vocals":
      return "Centred guitars and snare can leak in. Mono files cannot be separated.";
    case "panned":
      return "Only what is hard-panned to one side. Mono files cannot be separated.";
    case "other":
      return engine === "neural"
        ? "Everything that is not drums, bass or vocals."
        : "Everything that was not separated.";
  }
}

/** The label of a part for the song's engine ("Other" is not separated by the fast one). */
export function stemName(kind: StemKindId, engine: StemEngine): string {
  return kind === "other" && engine === "fast" ? "Other (not separated)" : STEM_LABELS[kind];
}

/** `3:05` for 185 seconds. */
export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A size such as `128 MB`. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

/** "Drums, bass and vocals". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What the feature cannot do, for the card on the start screen. */
export const STEM_SEPARATION_LIMITS: readonly string[] = [
  "The parts are separated by signal processing, so some of the other instruments can leak into each one.",
  "You choose from drums, bass, vocals and guitars and keys; the app does not detect which instruments are in a song.",
  "A mono file cannot be split into vocals and panned parts.",
  "Slowing a song down re-renders it after every mute, solo or volume change.",
];
