import { usePromise } from "@/hooks/use-promise";
import { canExportM4a, getAppInfo } from "@/lib/tauri";

/** Whether the desktop app on this platform can export M4A files (false until known, and in a browser). */
export function useM4aSupport(): boolean {
  const state = usePromise(getAppInfo);
  return state.status === "fulfilled" && canExportM4a(state.value);
}
