import {
  CircleIcon,
  Grid3x3Icon,
  KeyboardIcon,
  SettingsIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { deviceLabel, useMidiDevices } from "@/components/midi/use-midi-devices";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { readMidiPrefs, storeMidiPrefs, type MidiRecordPrefs } from "@/lib/midi/prefs";
import { RECORD_MODES, type MidiRecordMode } from "@/lib/midi/record";
import { cn } from "@/lib/utils";

/**
 * The bar shown while a MIDI lane is armed (ADR 0006): which devices it listens to (with a light
 * that flashes on every note), how the next take records (mode, start, count-in, where the
 * result goes, input quantize), the on-screen and computer-keyboard input, and Record. While
 * recording it shows Stop and Cancel.
 */
export function MidiArmedBar({
  laneName,
  recording,
  onRecord,
  onStop,
  onCancel,
  onDisarm,
  onPadBoard,
  onSettings,
}: {
  laneName: string;
  recording: boolean;
  onRecord: () => void;
  onStop: () => void;
  onCancel: () => void;
  onDisarm: () => void;
  onPadBoard: () => void;
  onSettings: () => void;
}) {
  const [prefs, setPrefs] = useState<MidiRecordPrefs>(readMidiPrefs);
  const { devices, activity } = useMidiDevices();
  const set = (patch: Partial<MidiRecordPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    storeMidiPrefs(next);
  };
  const connected = devices.filter((d) => d.connected && d.settings.enabled);
  const select = "h-8 rounded-md border bg-card px-2 text-sm";
  const source =
    connected.length === 0
      ? "No MIDI device: the on-screen pads play"
      : connected.length === 1
        ? `Listening to ${deviceLabel(connected[0]!)}`
        : `Listening to ${connected.length} devices`;

  return (
    <section
      aria-label="Armed MIDI lane"
      data-testid="midi-armed-bar"
      data-tour="midi-armed-bar"
      className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 flex-col gap-2 rounded-lg border bg-popover px-4 py-2 text-popover-foreground shadow-lg"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CircleIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-destructive",
            recording ? "animate-pulse fill-destructive" : "fill-destructive/30",
          )}
        />
        <p role="status" className="text-sm font-medium">
          {recording
            ? `Recording on ${laneName}. Space keeps it, Escape throws it away.`
            : `${laneName} is armed`}
        </p>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ActivityLight at={activity?.at ?? null} />
          {source}
        </span>
        <div className="ml-auto flex gap-1">
          {recording ? (
            <>
              <Button size="sm" onClick={onStop}>
                <SquareIcon data-icon="inline-start" className="fill-current" />
                Stop
              </Button>
              <Button size="sm" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={onRecord} data-tour="midi-record">
                <CircleIcon data-icon="inline-start" className="fill-current" />
                Record
              </Button>
              <Button size="sm" variant="outline" onClick={onPadBoard}>
                <Grid3x3Icon data-icon="inline-start" />
                Pad board
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="MIDI settings"
                title="MIDI devices and controls"
                onClick={onSettings}
              >
                <SettingsIcon />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Disarm the lane"
                onClick={onDisarm}
              >
                <XIcon />
              </Button>
            </>
          )}
        </div>
      </div>
      {!recording && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label className="flex items-center gap-1.5">
            Mode
            <select
              aria-label="Record mode"
              className={select}
              value={prefs.mode}
              title={RECORD_MODES.find((m) => m.value === prefs.mode)?.hint}
              onChange={(e) => set({ mode: e.target.value as MidiRecordMode })}
            >
              {RECORD_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Start
            <select
              aria-label="Where the take starts"
              className={select}
              value={prefs.span}
              onChange={(e) => set({ span: e.target.value as MidiRecordPrefs["span"] })}
            >
              <option value="playhead">At the playhead</option>
              <option value="punch">Punch the selected bars</option>
              <option value="loop">Loop the selected bars</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Result
            <select
              aria-label="Where the result goes"
              className={select}
              value={prefs.destination}
              onChange={(e) =>
                set({ destination: e.target.value as MidiRecordPrefs["destination"] })
              }
            >
              <option value="lane">This lane</option>
              <option value="newLane">A new lane</option>
              <option value="tab">Into the tab</option>
            </select>
          </label>
          <span className="flex items-center gap-1.5">
            <Switch
              aria-label="Count-in"
              checked={prefs.countIn}
              onCheckedChange={(countIn) => set({ countIn })}
            />
            Count-in
          </span>
          <span className="flex items-center gap-1.5">
            <Switch
              aria-label="Quantize to 1/16"
              checked={prefs.inputQuantize}
              onCheckedChange={(inputQuantize) => set({ inputQuantize })}
            />
            Quantize to 1/16
          </span>
          <span
            className="flex items-center gap-1.5"
            title="A S D F … play notes, Z and X change the octave"
          >
            <Switch
              aria-label="Computer keyboard plays notes"
              checked={prefs.computerKeyboard}
              onCheckedChange={(computerKeyboard) => set({ computerKeyboard })}
            />
            <KeyboardIcon aria-hidden="true" className="size-4" />
            Computer keyboard
          </span>
          <label className="flex items-center gap-1.5">
            Pad velocity
            <input
              type="number"
              aria-label="Velocity of the on-screen pads"
              className="h-8 w-16 rounded-md border bg-card px-2 text-sm"
              min={1}
              max={127}
              value={prefs.padVelocity}
              onChange={(e) =>
                set({ padVelocity: Math.min(127, Math.max(1, Number(e.target.value) || 100)) })
              }
            />
          </label>
        </div>
      )}
    </section>
  );
}

/** A light that flashes on every note or control (keyed by its time, so each flash restarts). */
export function ActivityLight({ at }: { at: number | null }) {
  return (
    <span
      aria-hidden="true"
      data-testid="midi-activity-light"
      className="relative size-2.5 shrink-0 rounded-full border border-foreground/30"
    >
      {at !== null && (
        <span key={at} className="midi-flash absolute -inset-px rounded-full bg-emerald-500" />
      )}
    </span>
  );
}
