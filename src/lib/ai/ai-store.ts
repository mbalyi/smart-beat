import { useSyncExternalStore } from "react";

import { errorText } from "@/lib/errors";
import {
  acceptMuscriptorTerms,
  cancelMuscriptorDownload,
  downloadMuscriptorModel,
  isTauri,
  muscriptorStatus,
  type MuscriptorSize,
  type MuscriptorStatus,
} from "@/lib/tauri";
import { track } from "@/lib/telemetry";
import { readSize, storeSize } from "@/lib/ai/muscriptor-sizes";

/** The dialogs that can ask for the installer, and that it hands the user back to. */
export type AiReturn = "record" | "audio";

/**
 * The state of the MuScriptor model and of the installer dialog, shared by every dialog that
 * needs the model (Record to tab, Import from Audio) so that they agree. A tiny external store
 * instead of props: Record to tab lives inside a song's workspace, Import from Audio at the app
 * level, and the installer opens above both.
 */
export interface AiState {
  /** The status is known (it is never known in a browser). */
  ready: boolean;
  status: MuscriptorStatus | null;
  size: MuscriptorSize;
  /** A download is running: its size and 0…1. */
  download: { size: MuscriptorSize; fraction: number } | null;
  error: string | null;
  installer: { open: boolean; returnTo: AiReturn | null };
}

const initial = (): AiState => ({
  ready: false,
  status: null,
  size: readSize(),
  download: null,
  error: null,
  installer: { open: false, returnTo: null },
});

let state: AiState = initial();
const listeners = new Set<() => void>();
const set = (patch: Partial<AiState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Resets everything. For tests. */
export function resetAiStore(): void {
  state = initial();
  running = false;
  returners.clear();
  listeners.forEach((listener) => listener());
}

/** Puts the store in a known state. For tests. */
export function seedAiState(patch: Partial<AiState>): void {
  set(patch);
}
/** A status with the terms accepted and `installed` sizes on disk. For tests. */
export function statusWith(
  installed: MuscriptorSize[],
  termsAccepted = true,
): NonNullable<AiState["status"]> {
  return {
    termsAccepted,
    termsVersion: 1,
    sizes: (["small", "medium", "large"] as const).map((size) => ({
      size,
      bytes: { small: 209_425_152, medium: 618_442_496, large: 2_739_142_176 }[size],
      installed: installed.includes(size),
      partialBytes: 0,
    })),
  };
}

export const getAiState = (): AiState => state;
export const useAiState = (): AiState => useSyncExternalStore(subscribe, getAiState);

export const isInstalled = (s: AiState, size: MuscriptorSize = s.size): boolean =>
  s.status?.sizes.find((entry) => entry.size === size)?.installed ?? false;
/** The detail of `ai_transcribe_start` and `ai_transcribe_file`: is the rights confirmation on file? */
export const rightsDetail = (): "rights_confirmed" | "rights_unconfirmed" =>
  state.status?.termsAccepted ? "rights_confirmed" : "rights_unconfirmed";
/** Some size is installed and the terms are accepted: the AI mode can run. */
export const canRun = (s: AiState): boolean => Boolean(s.status?.termsAccepted) && isInstalled(s);

export async function refreshAi(): Promise<void> {
  if (!isTauri()) return;
  try {
    const status = await muscriptorStatus();
    // The chosen size follows what is there: the first installed one when the pick is missing.
    const size = status.sizes.find((entry) => entry.size === state.size)?.installed
      ? state.size
      : (status.sizes.find((entry) => entry.installed)?.size ?? state.size);
    set({ ready: true, status, size });
  } catch (reason) {
    set({ ready: false, error: errorText(reason) });
  }
}

export function chooseSize(size: MuscriptorSize): void {
  storeSize(size);
  set({ size });
}

let running = false;
/**
 * Records the acceptance (the user ticked the rights box) and downloads `size`. Counts the
 * install and the confirmation. Resolves when it ended; a failure or a stop is in `error`.
 */
export async function installModel(size: MuscriptorSize, rightsConfirmed: boolean): Promise<void> {
  if (running) return;
  running = true;
  set({ error: null, download: { size, fraction: 0 } });
  try {
    if (!state.status?.termsAccepted) {
      const accepted = await acceptMuscriptorTerms(rightsConfirmed);
      track("ai_rights_confirmed");
      set({ status: accepted });
    }
    const status = await downloadMuscriptorModel(size, (fraction) =>
      set({ download: { size, fraction } }),
    );
    track("ai_install", size);
    set({ status, size, ready: true });
    storeSize(size);
  } catch (reason) {
    const message = errorText(reason);
    set({ error: message === "Download stopped." ? null : message });
    await refreshAi();
  } finally {
    running = false;
    set({ download: null });
  }
}

export function stopInstall(): void {
  void cancelMuscriptorDownload();
}

/** Who takes the user back when the installer closes, by the dialog that asked. */
const returners = new Set<{ to: AiReturn; handler: () => void }>();
/**
 * Registers how a dialog reopens when the installer it asked for closes. Every registered handler
 * of that dialog runs (a window can hold several songs: each decides whether it is the one on
 * screen). Returns the way to unregister.
 */
export function onInstallerReturn(to: AiReturn, handler: () => void): () => void {
  const entry = { to, handler };
  returners.add(entry);
  return () => returners.delete(entry);
}

/** Opens the installer above whatever asked for it. The asker closes itself first. */
export function openInstaller(returnTo: AiReturn): void {
  set({ installer: { open: true, returnTo }, error: null });
}
/** Closes the installer and hands the user back to the dialog that opened it. */
export function closeInstaller(): void {
  const { returnTo } = state.installer;
  set({ installer: { open: false, returnTo: null } });
  if (returnTo) for (const entry of [...returners]) if (entry.to === returnTo) entry.handler();
}
