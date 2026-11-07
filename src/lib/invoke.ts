import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

import { errorDetail } from "@/lib/error-counters";

/**
 * Tauri's `invoke`, plus the `error` usage counter (docs/analytics.md, #164): when a command
 * rejects, the failure is counted under a fixed `<area>:<kind>` and the original rejection is
 * thrown on unchanged. Counting is fire-and-forget and can never change or delay the result.
 * Use this instead of importing `invoke` from `@tauri-apps/api/core`.
 */
export async function invoke<T>(
  command: string,
  ...rest: [args?: InvokeArgs, options?: InvokeOptions]
): Promise<T> {
  try {
    // The arguments are passed on exactly as given, so callers and mocks see the same call.
    return await tauriInvoke<T>(command, ...rest);
  } catch (error) {
    countFailure(command, error);
    throw error;
  }
}

function countFailure(command: string, error: unknown): void {
  try {
    // In a browser there is no core to count in (and no bridge to call).
    if (typeof window === "undefined" || typeof window.__TAURI_INTERNALS__?.invoke !== "function")
      return;
    const format = errorDetail(command, error);
    if (format === null) return;
    // The raw invoke on purpose: a failing counter must not count itself.
    void tauriInvoke("track_event", { event: "error", format }).catch(() => {});
  } catch {
    // Counting never gets in the way.
  }
}
