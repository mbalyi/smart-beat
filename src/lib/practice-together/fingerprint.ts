import { writeAlphaTex } from "@/lib/export/alphatex";
import type { ScoreFingerprint } from "@/lib/practice-together/protocol";
import { fileKey } from "@/lib/score/format";
import type { Score } from "@/lib/score/model";

/**
 * Identifies the score as it is open now, edits included: the SHA-256 of its alphaTex text. Two
 * apps with the same file open (and no different edits) get the same key, whatever the file format.
 */
export async function scoreFingerprint(score: Score): Promise<ScoreFingerprint> {
  const text = writeAlphaTex(score);
  return { key: await fileKey(new TextEncoder().encode(text)), bars: score.masterBars.length };
}
