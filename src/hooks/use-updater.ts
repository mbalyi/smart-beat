import { useCallback, useEffect, useRef, useState } from "react";

import { errorText } from "@/lib/errors";
import { getAppInfo, isTauri } from "@/lib/tauri";
import { track } from "@/lib/telemetry";
import {
  AUTO_CHECK_DELAY_MS,
  checkForUpdate,
  readLastAutoCheck,
  shouldAutoCheck,
  writeLastAutoCheck,
  type DownloadProgress,
  type PendingUpdate,
  type UpdateInfo,
} from "@/lib/updater";

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; version: string }
  | { status: "available"; info: UpdateInfo }
  | { status: "downloading"; info: UpdateInfo; progress: DownloadProgress }
  | { status: "installing"; info: UpdateInfo }
  | { status: "error"; message: string };

export interface Updater {
  state: UpdaterState;
  /**
   * Whether the update dialog shows. An automatic check stays invisible unless it finds an
   * update; a check the user asked for always reports its result.
   */
  open: boolean;
  /** Help › Check for Updates…: checks now and reports the result, whatever it is. */
  checkNow: () => void;
  /** Download & Install: only ever called from the button. */
  install: () => void;
  /** Later / Close. Ignored while an update is downloading or installing. */
  dismiss: () => void;
}

/**
 * Update checks for the desktop app: one automatic check a day, a little after startup, and
 * the manual one from the Help menu. Installing needs the user's explicit click.
 */
export function useUpdater({ autoCheck = true }: { autoCheck?: boolean } = {}): Updater {
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const pending = useRef<PendingUpdate | null>(null);
  const running = useRef(false);
  /** The user asked while a check was already running: report its result too. */
  const report = useRef(false);
  /** An update is being downloaded or installed: the dialog cannot be dismissed. */
  const installing = useRef(false);

  const release = useCallback(() => {
    const old = pending.current;
    pending.current = null;
    old?.close().catch(() => {});
  }, []);

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (manual) {
        report.current = true;
        setState({ status: "checking" });
        setOpen(true);
      }
      if (running.current) return;
      running.current = true;
      track("update_check");

      try {
        const found = await checkForUpdate();
        // Only a check that got an answer counts: when the network is down, try again next start.
        if (!manual) writeLastAutoCheck(Date.now());
        release();
        pending.current = found;
        if (found) {
          setState({ status: "available", info: found.info });
          setOpen(true);
        } else if (report.current) {
          const info = await getAppInfo().catch(() => null);
          setState({ status: "up-to-date", version: info?.version ?? "" });
        } else {
          setState({ status: "idle" });
        }
      } catch (error) {
        if (report.current) setState({ status: "error", message: errorText(error) });
        else {
          console.warn("Automatic update check failed", error);
          setState({ status: "idle" });
        }
      } finally {
        report.current = false;
        running.current = false;
      }
    },
    [release],
  );

  useEffect(() => {
    if (!autoCheck || !isTauri()) return;
    if (!shouldAutoCheck(readLastAutoCheck(), Date.now())) return;
    const timer = setTimeout(() => void runCheck(false), AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoCheck, runCheck]);

  useEffect(() => release, [release]);

  const checkNow = useCallback(() => void runCheck(true), [runCheck]);

  const install = useCallback(() => {
    const update = pending.current;
    if (!update) return;
    const { info } = update;
    installing.current = true;
    setState({ status: "downloading", info, progress: { downloaded: 0, total: null } });
    update
      .install(
        (progress) => setState({ status: "downloading", info, progress }),
        () => {
          track("update_installed");
          setState({ status: "installing", info });
        },
      )
      .catch((error: unknown) => {
        // The update was used up by the attempt: "Try again" checks anew.
        installing.current = false;
        pending.current = null;
        setState({ status: "error", message: errorText(error) });
      });
  }, []);

  const dismiss = useCallback(() => {
    if (installing.current) return;
    setOpen(false);
    release();
    setState({ status: "idle" });
  }, [release]);

  return { state, open, checkNow, install, dismiss };
}
