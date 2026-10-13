/**
 * Third-party plugins (VST3 and CLAP, #80) for the pedalboard: the opt-in
 * switch, the scan of installed plugins, and per-block actions (the
 * plugin's own editor window, saving its settings, live latency/health).
 *
 * The backend holds the workers; this hook only mirrors the small UI state.
 * Outside the desktop app everything degrades to "unavailable".
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { EffectSlot } from "@/lib/audio/effects";
import {
  getPluginsEnabled,
  isCommandError,
  isTauri,
  openPluginEditor,
  pluginInfo,
  savePluginState,
  scanPlugins,
  setPluginsEnabled,
  type PluginSlotInfo,
  type ScannedPlugin,
} from "@/lib/tauri";

const STORAGE_KEY = "smart-beat.plugins-enabled";

export interface UsePlugins {
  /** Whether the desktop app has plugin blocks switched on. */
  available: boolean;
  /** The user's opt-in choice (persisted on this computer). */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** True while the backend applies the opt-in (it reloads every plugin block). */
  applying: boolean;
  /** Installed plugins from the last scan (empty until `refresh`). */
  scanned: ScannedPlugin[];
  /** Files the last scan skipped, one line each. */
  skipped: string[];
  scanning: boolean;
  refresh: () => void;
  /** Live status of the chain's plugin blocks, by block index. */
  info: Map<number, PluginSlotInfo>;
  /** The plugin block's display name with its added latency ("TONE3000 · +0.6 ms"). */
  describe: (slot: Extract<EffectSlot, { type: "plugin" }>, index: number) => string;
  openEditor: (index: number) => Promise<string | null>;
  saveState: (index: number) => Promise<{ state: string } | { error: string }>;
}

export function usePlugins(
  target: { track: number | "monitor" | null },
  sound: number,
  chain: readonly EffectSlot[],
): UsePlugins {
  const available = isTauri();
  const [enabled, setEnabledState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [scanned, setScanned] = useState<ScannedPlugin[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [info, setInfo] = useState<Map<number, PluginSlotInfo>>(new Map());
  // The enable value the backend has confirmed. `applying` is derived from the
  // choice: it is true from the moment the choice changes until the matching
  // `plugins_set_enabled` call settles. The ref holds the newest choice so a
  // slower, earlier call cannot mark a newer one as applied.
  const [appliedFor, setAppliedFor] = useState<boolean | null>(null);
  const latestEnabled = useRef(enabled);

  // The backend is authoritative (off on every launch); the opt-in choice is
  // remembered here and pushed in.
  useEffect(() => {
    if (!available) return;
    latestEnabled.current = enabled;
    setPluginsEnabled(enabled)
      .catch(() => {})
      .finally(() => {
        if (latestEnabled.current === enabled) setAppliedFor(enabled);
      });
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [available, enabled]);

  // Sync with the backend on mount (another window may have changed it).
  useEffect(() => {
    if (!available) return;
    getPluginsEnabled()
      .then((on) => {
        if (on) setEnabledState(true);
      })
      .catch(() => {});
  }, [available]);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    if (!on) setInfo(new Map());
  }, []);

  const refresh = useCallback(() => {
    if (!available || scanning) return;
    setScanning(true);
    scanPlugins()
      .then((report) => {
        setScanned(report.plugins);
        setSkipped(report.skipped);
      })
      .catch(() => {
        setScanned([]);
        setSkipped([]);
      })
      .finally(() => setScanning(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  // Poll while plugin blocks are visible so a later crash reaches the UI.
  useEffect(() => {
    if (!available || !enabled || !chain.some((slot) => slot.type === "plugin")) return;
    let cancelled = false;
    let pending = false;
    const refreshStatus = async () => {
      if (pending) return;
      pending = true;
      try {
        const list = await pluginInfo(target.track, sound);
        if (!cancelled) setInfo(new Map(list.map((item) => [item.index, item])));
      } catch {
        // Keep the last status if the app is temporarily busy.
      } finally {
        pending = false;
      }
    };
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [available, enabled, target.track, sound, chain]);

  const describe = useCallback(
    (slot: Extract<EffectSlot, { type: "plugin" }>, index: number) => {
      const name = slot.name || "Plugin";
      const item = info.get(index);
      if (!item || !(item.latencyMs > 0)) return name;
      return `${name} · +${item.latencyMs.toFixed(1)} ms`;
    },
    [info],
  );

  const openEditor = useCallback(
    async (index: number): Promise<string | null> => {
      try {
        await openPluginEditor(target.track, sound, index);
        return null;
      } catch (error) {
        return isCommandError(error) ? error.message : "The editor cannot open";
      }
    },
    [target.track, sound],
  );

  const saveState = useCallback(
    async (index: number): Promise<{ state: string } | { error: string }> => {
      try {
        const state = await savePluginState(target.track, sound, index);
        return { state };
      } catch (error) {
        return { error: isCommandError(error) ? error.message : "The settings cannot save" };
      }
    },
    [target.track, sound],
  );

  return {
    available,
    enabled,
    setEnabled,
    applying: available && appliedFor !== enabled,
    scanned,
    skipped,
    scanning,
    refresh,
    info,
    describe,
    openEditor,
    saveState,
  };
}
