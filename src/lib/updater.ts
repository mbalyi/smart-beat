/**
 * In-app updates (#82): the throttle for the automatic check and a thin wrapper around the Tauri
 * updater plugin. The plugin is registered in `src-tauri/src/lib.rs`; its endpoint
 * (`latest.json` on the newest GitHub Release) and public key are in `tauri.conf.json`.
 */
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";

/** Where the time of the last automatic check is remembered (per user, in the webview). */
export const LAST_AUTO_CHECK_KEY = "smart-beat:last-update-check";

/** The automatic check runs at most this often. */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The automatic check waits this long after startup, so it never competes with opening a song. */
export const AUTO_CHECK_DELAY_MS = 5_000;

/** Whether an automatic check is due: never done, a day or more ago, or the clock went back. */
export function shouldAutoCheck(lastCheck: number | null, now: number): boolean {
  if (lastCheck === null || !Number.isFinite(lastCheck)) return true;
  if (lastCheck > now) return true;
  return now - lastCheck >= AUTO_CHECK_INTERVAL_MS;
}

export function readLastAutoCheck(): number | null {
  try {
    const raw = localStorage.getItem(LAST_AUTO_CHECK_KEY);
    if (raw === null) return null;
    const time = Number(raw);
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

export function writeLastAutoCheck(time: number): void {
  try {
    localStorage.setItem(LAST_AUTO_CHECK_KEY, String(time));
  } catch {
    // Not remembered: the next start checks again.
  }
}

/** What the update dialog shows about a new version. */
export interface UpdateInfo {
  currentVersion: string;
  version: string;
  /** The release notes (plain text, taken from CHANGELOG.md). */
  notes: string;
}

export interface DownloadProgress {
  downloaded: number;
  /** `null` when the server did not say how big the download is. */
  total: number | null;
}

const MEGABYTE = 1024 * 1024;

const megabytes = (bytes: number) => `${(bytes / MEGABYTE).toFixed(1)} MB`;

/** "12.3 of 45.6 MB (27%)", or just what was downloaded when the size is unknown. */
export function describeProgress({ downloaded, total }: DownloadProgress): string {
  if (!total) return `${megabytes(downloaded)} downloaded`;
  const percent = Math.min(100, Math.floor((downloaded / total) * 100));
  return `${megabytes(downloaded)} of ${megabytes(total)} (${percent}%)`;
}

/** A newer version that was found and can be installed. */
export interface PendingUpdate {
  info: UpdateInfo;
  /**
   * Downloads and installs the update, then restarts the app. `onDownloaded` is called when
   * the download is complete and the installation starts. On Windows the installer ends the
   * app itself, so the call may never return.
   */
  install(
    onProgress: (progress: DownloadProgress) => void,
    onDownloaded: () => void,
  ): Promise<void>;
  /** Frees the update on the Rust side when it is not going to be installed. */
  close(): Promise<void>;
}

/** Asks the update server for a newer version. Resolves with `null` when this one is the latest. */
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  const update = await check();
  if (!update) return null;

  return {
    info: {
      currentVersion: update.currentVersion,
      version: update.version,
      notes: update.body?.trim() ?? "",
    },
    async install(onProgress, onDownloaded) {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            onProgress({ downloaded, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            onProgress({ downloaded, total });
            break;
          case "Finished":
            onDownloaded();
            break;
        }
      });
      await relaunch();
    },
    close: () => update.close(),
  };
}
