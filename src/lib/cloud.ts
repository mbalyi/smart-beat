import { invoke } from "@tauri-apps/api/core";

import { isTauri, NotInDesktopAppError } from "@/lib/tauri";

/** Cloud services Smart Beat can sign in to. Mirrors the Rust `cloud` module. */
export type CloudProvider = "drive" | "onedrive" | "dropbox";

export interface CloudAccount {
  provider: CloudProvider;
  /** Display name of the service, such as "Google Drive". */
  label: string;
  /** False when this build ships without credentials for the service. */
  configured: boolean;
  /** The signed-in account, or `null` when not connected. */
  account: string | null;
}

export type CloudFlushOutcome = "uploaded" | "conflict" | "waiting";

export interface CloudFlushResult {
  name: string;
  outcome: CloudFlushOutcome;
}

/** A save waiting to be uploaded. */
export interface PendingUpload {
  provider: CloudProvider;
  id: string;
  name: string;
  revision: string;
  conflict: boolean;
}

/** Account names stay on this computer: none of these calls is reported to usage statistics. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<T>(command, args);
}

/** Outside the desktop app there are no accounts. */
export async function listCloudAccounts(): Promise<CloudAccount[]> {
  if (!isTauri()) return [];
  return invoke<CloudAccount[]>("cloud_accounts");
}

/** Opens the system browser to sign in; resolves to the account name once it is done. */
export const connectCloudAccount = (provider: CloudProvider) =>
  call<string>("cloud_connect", { provider });

export const disconnectCloudAccount = (provider: CloudProvider) =>
  call<void>("cloud_disconnect", { provider });

/** Tries to upload the saves that are waiting. */
export const flushCloudUploads = () => call<CloudFlushResult[]>("cloud_flush");

/** Outside the desktop app nothing is pending. */
export async function listPendingUploads(): Promise<PendingUpload[]> {
  if (!isTauri()) return [];
  return invoke<PendingUpload[]>("cloud_pending");
}
