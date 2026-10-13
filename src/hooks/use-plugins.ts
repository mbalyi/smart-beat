/**
 * Third-party plugins (VST3 and CLAP, #80) for the pedalboard: the opt-in
 * switch, the scan of installed plugins, and per-block actions (the
 * plugin's own editor window, saving its settings, live latency/health).
 *
 * The backend holds the workers; this hook only mirrors the small UI state.
 * Outside the desktop app everything degrades to "unavailable".
 */
import { useCallback, useEffect, useState } from "react";

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
  target: { track: number | null },
  sound: number,
  chain: readonly EffectSlot[],
  sampleRate = 48000,
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

  // The backend is authoritative (off on every launch); the opt-in choice is
  // remembered here and pushed in.
  useEffect(() => {
    if (!available) return;
    setPluginsEnabled(enabled).catch(() => {});
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

  // Live status of this chain's plugin blocks (latency, health). The fetch
  // replaces the map, so a changed chain never shows another block's status.
  useEffect(() => {
    if (!available || !enabled) return;
    let cancelled = false;
    pluginInfo(target.track, sound)
      .then((list) => {
        if (!cancelled) setInfo(new Map(list.map((item) => [item.index, item])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [available, enabled, target.track, sound, chain]);

  const describe = useCallback(
    (slot: Extract<EffectSlot, { type: "plugin" }>, index: number) => {
      const name = slot.name || "Plugin";
      const item = info.get(index);
      if (!item || item.latencySamples === 0) return name;
      const ms = ((item.latencySamples / sampleRate) * 1000).toFixed(1);
      return `${name} · +${ms} ms`;
    },
    [info, sampleRate],
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
