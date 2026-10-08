import { loadRecentFiles } from "@/lib/tauri";

/** Remembers which side panels are open (#83). */
export const LAYOUT_STORAGE_KEY = "smart-beat:layout";

export interface LayoutPrefs {
  /** The tracks and mixer panel at the bottom. */
  mixer: boolean;
  /** The inspector at the side. */
  inspector: boolean;
}

/** What someone who used Smart Beat before this setting existed always had. */
export const CLASSIC_LAYOUT: LayoutPrefs = { mixer: true, inspector: true };
/** A first launch: the score and the playback controls, the rest a click away. */
export const FIRST_RUN_LAYOUT: LayoutPrefs = { mixer: false, inspector: false };

/** The saved panels, or null when nothing (valid) is saved. */
export function readLayoutPrefs(): LayoutPrefs | null {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LayoutPrefs>;
    if (typeof value.mixer !== "boolean" || typeof value.inspector !== "boolean") return null;
    return { mixer: value.mixer, inspector: value.inspector };
  } catch {
    return null;
  }
}

export function storeLayoutPrefs(prefs: LayoutPrefs) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered: the next song starts with the default panels.
  }
}

/** Whether this browser profile kept anything of Smart Beat's before (other than the layout). */
function hasOtherPreferences(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("smart-beat:") && key !== LAYOUT_STORAGE_KEY) return true;
    }
  } catch {
    // No storage: nothing to tell.
  }
  return false;
}

/**
 * Decides the panels once, at the first start of a version that has this setting: a new
 * install starts quiet, someone who used Smart Beat before (recent songs or saved
 * preferences) keeps the panels they had. A saved choice is never overwritten.
 */
export async function initLayoutPrefs(
  recentFiles: () => Promise<string[]> = loadRecentFiles,
): Promise<LayoutPrefs> {
  const saved = readLayoutPrefs();
  if (saved) return saved;
  let used = hasOtherPreferences();
  if (!used) {
    try {
      used = (await recentFiles()).length > 0;
    } catch {
      // Not the desktop app (or no list): judged by the preferences alone.
    }
  }
  // Another call may have decided meanwhile.
  const decided = readLayoutPrefs();
  if (decided) return decided;
  const prefs = used ? CLASSIC_LAYOUT : FIRST_RUN_LAYOUT;
  storeLayoutPrefs(prefs);
  return prefs;
}
