import { useEffect, useRef } from "react";

import { keyboardSemitone, readMidiPrefs } from "@/lib/midi/prefs";
import { drumOutputKey } from "@/lib/score/drum-map";
import {
  armMidiLane,
  isTauri,
  midiInject,
  onMidiEvent,
  type MidiControlEvent,
  type MidiMessage,
} from "@/lib/tauri";

/** How long an on-screen pad hit sounds before its note off (ms). */
const HIT_MS = 120;

/**
 * Live input on the armed MIDI lane (ADR 0006): tells the engine which lane plays live notes
 * (switching to the native engine when needed), plays the on-screen drum pads and (when switched
 * on) the computer keyboard through the MIDI input so they are heard and recorded like a device,
 * and passes mapped knobs and buttons on to the app.
 */
export function useMidiLaneInput(env: {
  armedLaneId: string | null;
  engineOn: boolean;
  ensureEngine: () => boolean;
  onControl: (event: MidiControlEvent) => void;
}) {
  const { armedLaneId, engineOn, ensureEngine } = env;
  const controlRef = useRef(env.onControl);
  useEffect(() => {
    controlRef.current = env.onControl;
  });

  useEffect(() => {
    if (!isTauri()) return;
    if (armedLaneId && !engineOn) ensureEngine();
    void armMidiLane(armedLaneId).catch(() => undefined);
  }, [armedLaneId, engineOn, ensureEngine]);
  useEffect(
    () => () => {
      if (isTauri()) void armMidiLane(null).catch(() => undefined);
    },
    [],
  );

  // Knobs and buttons mapped in Settings › MIDI devices (and transport buttons).
  useEffect(() => {
    if (!isTauri()) return;
    const off = onMidiEvent<MidiControlEvent>("midi://control", (e) => controlRef.current(e));
    return () => void off.then((stop) => Promise.resolve(stop())).catch(() => undefined);
  }, []);

  // The computer keyboard as a small piano while a MIDI lane is armed and it is switched on.
  useEffect(() => {
    if (!armedLaneId) return;
    let octave = 60;
    const held = new Map<string, number>();
    const send = (messages: MidiMessage[]) => void midiInject(messages).catch(() => undefined);
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || !!target.closest("input, textarea, select, [role='textbox']"));
    const onDown = (event: KeyboardEvent) => {
      const prefs = readMidiPrefs();
      if (!prefs.computerKeyboard || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "x") {
        octave = Math.min(108, Math.max(12, octave + (key === "x" ? 12 : -12)));
        event.preventDefault();
        return;
      }
      const semitone = keyboardSemitone(key);
      if (semitone === null) return;
      event.preventDefault();
      if (event.repeat || held.has(key)) return;
      const pitch = Math.min(127, octave + semitone);
      held.set(key, pitch);
      send([[0x90, pitch, prefs.padVelocity]]);
    };
    const onUp = (event: KeyboardEvent) => {
      const pitch = held.get(event.key.toLowerCase());
      if (pitch === undefined) return;
      held.delete(event.key.toLowerCase());
      send([[0x80, pitch, 0]]);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      if (held.size) send([...held.values()].map((p) => [0x80, p, 0] as MidiMessage));
    };
  }, [armedLaneId]);

  return {
    /** An on-screen drum pad was hit: played and recorded on the armed lane. */
    hitDrum: (sound: number) => {
      const key = drumOutputKey(sound);
      const velocity = readMidiPrefs().padVelocity;
      void midiInject([[0x99, key, velocity]]).catch(() => undefined);
      setTimeout(() => void midiInject([[0x89, key, 0]]).catch(() => undefined), HIT_MS);
    },
  };
}
