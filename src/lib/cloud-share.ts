import { invoke } from "@tauri-apps/api/core";

import type { CloudProvider, ShareLevel } from "@/lib/cloud";
import { createCloudItem, isCloudItem, providerOf, rememberCloudName } from "@/lib/cloud-items";
import {
  isTauri,
  NotInDesktopAppError,
  readScoreFile,
  saveStemBundleToCloud,
  type BundleProgress,
  type StemSong,
} from "@/lib/tauri";
import { baseName } from "@/lib/score/format";

export type { ShareLevel };

/**
 * What is being shared (#201): a file that is in a connected drive already, a tab on this
 * computer (copied to a drive first) or a separated song (saved to a drive as a `.sbstems` file
 * first). Stems are shared as their own file, with their own link.
 *
 * A share link is a secret like a token: it goes to the clipboard and into the dialog, and
 * nowhere else (not to the log, not to the recent list, not to usage statistics).
 */
export type ShareTarget =
  | { kind: "cloud"; item: string; name: string }
  | { kind: "tab"; path: string; name: string }
  | { kind: "stems"; songId: string; name: string };

/** The target for a recent or listed tab: a cloud item is shared as it is, a path is uploaded. */
export function tabShareTarget(path: string, name = baseName(path)): ShareTarget {
  return isCloudItem(path) ? { kind: "cloud", item: path, name } : { kind: "tab", path, name };
}

/** The target for a separated song: already in a drive, it is shared as it is. */
export function stemShareTarget(song: Pick<StemSong, "id" | "name" | "savedPath">): ShareTarget {
  return song.savedPath && isCloudItem(song.savedPath)
    ? { kind: "cloud", item: song.savedPath, name: `${song.name}.sbstems` }
    : { kind: "stems", songId: song.id, name: song.name };
}

/** The drive a target is in already, or `null` when it has to be uploaded to one first. */
export function targetProvider(target: ShareTarget): CloudProvider | null {
  return target.kind === "cloud" ? providerOf(target.item) : null;
}

/** Asks the service for a link to a file of a connected drive. */
export async function createShareLink(item: string, level: ShareLevel): Promise<string> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<string>("cloud_share", { item, level });
}

/**
 * Puts a local target in `provider` and returns its item id. A tab is copied as the file it is on
 * disk; stems are written and uploaded as a `.sbstems` file without the original song.
 */
export async function uploadForShare(
  target: Extract<ShareTarget, { kind: "tab" | "stems" }>,
  provider: CloudProvider,
  onProgress?: (progress: BundleProgress) => void,
): Promise<string> {
  if (!isTauri()) throw new NotInDesktopAppError();
  if (target.kind === "stems") {
    const saved = await saveStemBundleToCloud(
      { id: target.songId, provider, includeOriginal: false },
      onProgress,
    );
    return saved.item;
  }
  const name = baseName(target.path);
  const item = await createCloudItem(provider, name, await readScoreFile(target.path));
  rememberCloudName(item, name);
  return item;
}

/** Copies text to the clipboard; `false` when the system refuses (the dialog then shows it). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
