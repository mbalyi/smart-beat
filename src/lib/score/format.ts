/** `m:ss` (or `h:mm:ss`) for a duration in milliseconds. */
export function formatTime(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Spoken form of {@link formatTime}, e.g. "1 minute 5 seconds". */
export function describeTime(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts = [];
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (seconds > 0 || minutes === 0)
    parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

/**
 * Identifies a song by its content (lowercase hex SHA-256), so per-song
 * settings survive renaming or moving the file. Mirrors `FileKey` in
 * `src-tauri/src/mixer.rs`.
 */
export async function fileKey(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** File name without folders, e.g. for `C:\Songs\a.gp5` or `/songs/a.gp5`. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
