/** The quietest sound the level meter shows (dBFS). */
const FLOOR_DB = -60;

/** A peak (0…1) as a meter position (0…1): 0 at -60 dBFS and below, 1 at full scale. */
export function meterLevel(peak: number): number {
  if (!(peak > 0)) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(peak) - FLOOR_DB) / -FLOOR_DB));
}

/** The loudest sample of a block. */
export function peakOf(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  return peak;
}

/** What a player is told about the level: too quiet to use, fine, or about to distort. */
export function levelWords(level: number): string {
  if (level < 0.05) return "No sound";
  if (level < 0.4) return "Quiet";
  if (level < 0.95) return "Good";
  return "Loud";
}

/** A meter that falls back slowly: the new level if it is higher, else `fall` of the old one. */
export function smoothLevel(previous: number, next: number, fall = 0.85): number {
  return Math.max(next, previous * fall);
}

/** 75 seconds as "1:15". */
export function formatElapsed(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
