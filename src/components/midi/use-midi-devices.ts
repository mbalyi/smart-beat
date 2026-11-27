import { useEffect, useState } from "react";

import {
  isTauri,
  listMidiDevices,
  onMidiEvent,
  type MidiActivity,
  type MidiDevice,
} from "@/lib/tauri";

/**
 * The MIDI devices and what they just sent (ADR 0006): the list follows plugging in and out, and
 * `activity` is the last note or control seen (the "test" light and pad learning).
 */
export function useMidiDevices(enabled = true) {
  const [devices, setDevices] = useState<MidiDevice[]>([]);
  const [activity, setActivity] = useState<(MidiActivity & { at: number }) | null>(null);
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let alive = true;
    void listMidiDevices()
      .then((list) => alive && setDevices(list))
      .catch(() => undefined);
    const off = [
      onMidiEvent<MidiDevice[]>("midi://devices", (list) => alive && setDevices(list)),
      onMidiEvent<MidiActivity>(
        "midi://activity",
        (a) => alive && setActivity({ ...a, at: Date.now() }),
      ),
    ];
    return () => {
      alive = false;
      // A test double without the event plugin may refuse to unlisten: nothing to undo then.
      for (const p of off) void p.then((stop) => Promise.resolve(stop())).catch(() => undefined);
    };
  }, [enabled]);
  return { devices, setDevices, activity };
}

/** A device's name as the player sees it: their own name, or the system's. */
export const deviceLabel = (d: Pick<MidiDevice, "name" | "settings">): string =>
  d.settings.alias.trim() || d.name;
