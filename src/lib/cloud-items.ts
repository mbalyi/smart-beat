import { invoke } from "@tauri-apps/api/core";

import type { CloudAccount, CloudProvider } from "@/lib/cloud";
import { isCommandError, isTauri } from "@/lib/tauri";

export type { CloudProvider };

export const CLOUD_PROVIDERS: readonly CloudProvider[] = ["drive", "onedrive", "dropbox"];

export const PROVIDER_LABELS: Record<CloudProvider, string> = {
  drive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
};

/** A tab in a connected online drive (field names as the Rust side serializes them). */
export type CloudItem = {
  id: string;
  name: string;
  revision: string;
  size: number;
  modified_ms: number;
};

/** Outcome of a Save: uploaded now, or kept on this computer until the connection is back. */
export type CloudSaveResult = "saved" | "queued";

/** An item id looks like `drive:<id>`; a Windows path such as `C:\a.gp` is not one. */
export function isCloudItem(id: string): boolean {
  return /^(drive|onedrive|dropbox):./.test(id);
}

/** The provider of an item id, or null for a local path. */
export function providerOf(id: string): CloudProvider | null {
  return isCloudItem(id) ? (id.slice(0, id.indexOf(":")) as CloudProvider) : null;
}

export function providerLabel(provider: CloudProvider): string {
  return PROVIDER_LABELS[provider];
}

function needDesktop() {
  if (!isTauri()) throw { kind: "io", message: "Cloud drives need the desktop app." };
}

/** The tabs of a connected provider; each `id` is an item id (`drive:<id>`). */
export async function listCloudItems(provider: CloudProvider): Promise<CloudItem[]> {
  needDesktop();
  const items = await invoke<CloudItem[]>("cloud_list", { provider });
  // A bare provider id has no provider and no extension; never hand one to the open path.
  return items.map((item) => ({
    ...item,
    id: item.id.startsWith(`${provider}:`) ? item.id : `${provider}:${item.id}`,
  }));
}

/**
 * The file name the backend recorded when it read or created `item` (call after
 * `readCloudItem`). The name decides the format, so it never comes from local storage.
 */
export async function fetchCloudItemName(item: string): Promise<string> {
  needDesktop();
  return invoke<string>("cloud_item_name", { item });
}

/** Downloads a tab. */
export async function readCloudItem(item: string): Promise<Uint8Array> {
  needDesktop();
  // The Rust command answers with raw bytes, which arrive as an ArrayBuffer.
  return new Uint8Array(await invoke<ArrayBuffer>("cloud_read", { item }));
}

/** Uploads a changed tab; "queued" means it is saved offline and uploads later. */
export async function saveCloudItem(item: string, bytes: Uint8Array): Promise<CloudSaveResult> {
  needDesktop();
  // The bytes are the raw request body; the item travels in a header.
  return invoke<CloudSaveResult>("cloud_save", bytes, { headers: { item } });
}

/** Creates a new tab in a provider; resolves to its item id (`drive:<id>`). */
export async function createCloudItem(
  provider: CloudProvider,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  needDesktop();
  return invoke<string>("cloud_create", bytes, {
    headers: { provider, name: encodeURIComponent(name) },
  });
}

/** The user can fix this by waiting or reconnecting; the item stays in the recent list. */
export function isCloudAvailabilityError(error: unknown): boolean {
  return isCommandError(error) && (error.kind === "network" || error.kind === "auth-expired");
}

/** A clear message for a cloud failure, or null for other errors. */
export function cloudErrorText(error: unknown, provider: CloudProvider | null): string | null {
  if (!isCommandError(error) || !provider) return null;
  if (error.kind === "auth-expired") return `Reconnect ${providerLabel(provider)} in Settings`;
  if (error.kind === "network")
    return `${providerLabel(provider)} can't be reached. Check your connection; the song stays in your recent list.`;
  return null;
}

const NAMES_KEY = "smart-beat:cloud-names";

/** Only a label for the recent list (the backend's `cloud_item_name` is the source of truth). */
export function rememberCloudName(id: string, name: string) {
  try {
    const all = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}") as Record<string, string>;
    all[id] = name;
    localStorage.setItem(NAMES_KEY, JSON.stringify(all));
  } catch {
    // The list falls back to the id.
  }
}

export function cloudItemName(id: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}") as Record<string, string>;
    return all[id] ?? null;
  } catch {
    return null;
  }
}

/** One online drive in the Open and Save As choosers. */
export type CloudDrive = {
  provider: CloudProvider;
  label: string;
  /** Can't be used yet: the chooser shows it greyed out with `hint`. */
  disabled?: boolean;
  hint?: string;
};

/** Every provider for the choosers: unusable ones are disabled with the reason why. */
export function toCloudDrives(accounts: CloudAccount[]): CloudDrive[] {
  return accounts.map<CloudDrive>((a) => {
    const base = { provider: a.provider, label: a.label };
    if (!a.configured) return { ...base, disabled: true, hint: "Not available in this build" };
    if (!a.account) return { ...base, disabled: true, hint: "Not connected" };
    return base;
  });
}
