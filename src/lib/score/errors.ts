import { errorText } from "@/lib/errors";
import { ScoreLoadError } from "@/lib/score/score";
import { isCommandError, SCORE_EXTENSIONS } from "@/lib/tauri";

const EXTENSION_LIST = SCORE_EXTENSIONS.map((ext) => `.${ext}`).join(", ");

/** Explains why a song could not be opened, in words a musician understands. */
export function describeOpenError(error: unknown): string {
  if (isCommandError(error)) {
    switch (error.kind) {
      case "unsupported-type":
        return `Smart Beat opens Guitar Pro files (${EXTENSION_LIST}).`;
      case "not-a-score":
        return "This is not a Guitar Pro file, or it is damaged.";
      case "too-large":
        return "The file is too large to open.";
      case "not-found":
        return "The file could not be found. It may have been moved or deleted.";
      default:
        return error.message;
    }
  }
  if (error instanceof ScoreLoadError) {
    return "The file is damaged or uses a Guitar Pro version Smart Beat can't read yet.";
  }
  return errorText(error);
}

/** Whether a dropped or picked file name looks like a Guitar Pro file. */
export function hasScoreExtension(name: string): boolean {
  const extension = name.split(".").pop()?.toLowerCase();
  return name.includes(".") && SCORE_EXTENSIONS.some((ext) => ext === extension);
}
