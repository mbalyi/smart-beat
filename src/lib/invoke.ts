import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

import { errorDetail } from "@/lib/error-counters";
import { buildTrace } from "@/lib/scrub-stack";

/**
 * Tauri's `invoke`, plus the `error` usage counter (docs/analytics.md, #164): when a command
 * rejects, the failure is counted under a fixed `<area>:<kind>` and the original rejection is
 * thrown on unchanged. The count carries an anonymised code location (#242): the command name,
 * the Rust `origin` (`file:line` inside the app) and a few scrubbed JavaScript call sites, plus
 * the extension of the file involved when it is a known format (see `scrub-stack.ts`). The
 * error message and the arguments are never read or sent. Counting is fire-and-forget and can
 * never change or delay the result. Use this instead of importing `invoke` from
 * `@tauri-apps/api/core`.
 */
export async function invoke<T>(
  command: string,
  ...rest: [args?: InvokeArgs, options?: InvokeOptions]
): Promise<T> {
  try {
    // The arguments are passed on exactly as given, so callers and mocks see the same call.
    return await tauriInvoke<T>(command, ...rest);
  } catch (error) {
    countFailure(command, error, rest[0]);
    throw error;
  }
}

function countFailure(command: string, error: unknown, args: unknown): void {
  try {
    // In a browser there is no core to count in (and no bridge to call).
    if (typeof window === "undefined" || typeof window.__TAURI_INTERNALS__?.invoke !== "function")
      return;
    const format = errorDetail(command, error);
    if (format === null) return;
    // The stack is made here, in the failure path only, so the hot path pays nothing. Its first
    // two call sites are this function and `invoke`.
    const trace = buildTrace({ command, error, args, stack: new Error().stack, skip: 2 });
    // The raw invoke on purpose: a failing counter must not count itself, and `track` would
    // drop the trace (it only passes known details).
    void tauriInvoke("track_event", { event: "error", format, ...(trace ? { trace } : {}) }).catch(
      () => {},
    );
  } catch {
    // Counting never gets in the way.
  }
}
