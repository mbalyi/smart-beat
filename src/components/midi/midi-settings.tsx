import { RadioIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ActivityLight } from "@/components/midi/midi-armed-bar";
import { deviceLabel, useMidiDevices } from "@/components/midi/use-midi-devices";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/errors";
import { CONTROL_ACTIONS, controlDescription } from "@/lib/midi/controls";
import {
  forgetMidiDevice,
  updateMidiDevice,
  type MidiControlAction,
  type MidiDevice,
  type MidiDeviceSettings,
} from "@/lib/tauri";

/**
 * Settings › MIDI devices (ADR 0006): every pad controller, keyboard or drum kit that was
 * connected, with a light that flashes when it sends; a name of your own, on or off, a time
 * offset, the channel it listens on, a transposition and a fixed velocity; and knobs and buttons
 * learned for app controls (play, record, volume…).
 */
export function MidiSettings() {
  const { devices, setDevices, activity } = useMidiDevices();
  const [learn, setLearn] = useState<{ device: string; action: MidiControlAction } | null>(null);
  const [seen, setSeen] = useState<number | null>(null);

  const save = async (settings: MidiDeviceSettings) => {
    try {
      setDevices(await updateMidiDevice(settings));
    } catch (error) {
      toast.error("Couldn't save the MIDI device", { description: errorText(error) });
    }
  };

  // The next knob, fader or button on the device becomes the control.
  if (activity && activity.at !== seen) {
    setSeen(activity.at);
    const device = learn && devices.find((d) => d.name === learn.device);
    if (
      learn &&
      device &&
      activity.device === learn.device &&
      (activity.kind === "cc" || activity.kind === "note")
    ) {
      setLearn(null);
      const control = {
        source: activity.kind === "cc" ? ("cc" as const) : ("note" as const),
        chan: activity.chan,
        number: activity.number,
        action: learn.action,
        relative: false,
      };
      void save({
        ...device.settings,
        controls: [
          ...device.settings.controls.filter(
            (c) =>
              !(
                c.source === control.source &&
                c.chan === control.chan &&
                c.number === control.number
              ),
          ),
          control,
        ],
      });
    }
  }

  if (devices.length === 0) {
    return (
      <div
        className="flex flex-col gap-1 text-sm text-muted-foreground"
        data-testid="midi-settings"
      >
        <p>
          No MIDI device is connected yet. Plug in a pad controller, keyboard or drum kit over USB.
        </p>
        <p>
          Bluetooth MIDI devices are paired first in the Mac’s Audio MIDI Setup (Window › Show MIDI
          Studio › Bluetooth); then they show up here like any other.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="midi-settings">
      {devices.map((d) => (
        <DeviceCard
          key={d.name}
          device={d}
          lit={activity?.device === d.name ? activity.at : null}
          learning={learn?.device === d.name ? learn.action : null}
          onLearn={(action) => setLearn(action ? { device: d.name, action } : null)}
          onSave={(s) => void save(s)}
          onForget={() =>
            void forgetMidiDevice(d.name)
              .then(setDevices)
              .catch((e: unknown) =>
                toast.error("Couldn't forget the device", { description: errorText(e) }),
              )
          }
        />
      ))}
      <p className="text-xs text-muted-foreground">
        Bluetooth MIDI devices are paired in the Mac’s Audio MIDI Setup first.
      </p>
    </div>
  );
}

function DeviceCard({
  device,
  lit,
  learning,
  onLearn,
  onSave,
  onForget,
}: {
  device: MidiDevice;
  lit: number | null;
  learning: MidiControlAction | null;
  onLearn: (action: MidiControlAction | null) => void;
  onSave: (settings: MidiDeviceSettings) => void;
  onForget: () => void;
}) {
  const s = device.settings;
  const [action, setAction] = useState<MidiControlAction>("playPause");
  const set = (patch: Partial<MidiDeviceSettings>) => onSave({ ...s, ...patch });
  const input = "h-8 rounded-md border bg-card px-2 text-sm";
  const label = deviceLabel(device);
  return (
    <section
      aria-label={`MIDI device ${label}`}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ActivityLight at={lit} />
        <span className="font-semibold">{label}</span>
        <span className="text-xs text-muted-foreground">
          {device.connected ? "Connected" : "Not connected"}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-sm">
          <Switch
            aria-label={`Use ${label}`}
            checked={s.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
          />
          On
        </span>
        <Button size="icon-xs" variant="ghost" aria-label={`Forget ${label}`} onClick={onForget}>
          <Trash2Icon />
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2">
          Name
          <input
            className={input}
            aria-label={`Name of ${device.name}`}
            defaultValue={s.alias}
            placeholder={device.name}
            onBlur={(e) =>
              e.target.value !== s.alias && set({ alias: e.target.value.slice(0, 80) })
            }
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          Timing offset (ms)
          <input
            type="number"
            className={`${input} w-20`}
            aria-label={`Timing offset of ${label} in ms`}
            min={-500}
            max={500}
            defaultValue={s.offsetMs}
            onBlur={(e) =>
              set({ offsetMs: Math.min(500, Math.max(-500, Number(e.target.value) || 0)) })
            }
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          Channel
          <select
            className={input}
            aria-label={`Channel ${label} listens on`}
            value={s.channel ?? ""}
            onChange={(e) =>
              set({ channel: e.target.value === "" ? null : Number(e.target.value) })
            }
          >
            <option value="">All channels</option>
            {Array.from({ length: 16 }, (_, c) => (
              <option key={c} value={c}>
                {c + 1}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Transpose (semitones)
          <input
            type="number"
            className={`${input} w-20`}
            aria-label={`Transposition of ${label}`}
            min={-48}
            max={48}
            defaultValue={s.transpose}
            onBlur={(e) =>
              set({
                transpose: Math.min(48, Math.max(-48, Math.round(Number(e.target.value) || 0))),
              })
            }
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          Fixed velocity
          <input
            type="number"
            className={`${input} w-20`}
            aria-label={`Fixed velocity of ${label} (empty: as played)`}
            min={1}
            max={127}
            placeholder="As played"
            defaultValue={s.fixedVelocity ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim();
              set({
                fixedVelocity:
                  v === "" ? null : Math.min(127, Math.max(1, Math.round(Number(v) || 100))),
              });
            }}
          />
        </label>
        <span className="flex items-center justify-between gap-2">
          Only for controls
          <Switch
            aria-label={`${label} only controls the app (plays no notes)`}
            checked={s.controlOnly}
            onCheckedChange={(controlOnly) => set({ controlOnly })}
          />
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <h4 className="text-sm font-medium">Knobs and buttons</h4>
        {s.controls.length === 0 && (
          <p className="text-xs text-muted-foreground">
            None yet. Transport buttons that send MIDI Machine Control already play, stop and
            record.
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {s.controls.map((c) => (
            <li
              key={`${c.source}-${c.chan}-${c.number}`}
              className="flex items-center gap-2 text-sm"
            >
              <span className="flex-1">{controlDescription(c)}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove: ${controlDescription(c)}`}
                onClick={() => set({ controls: s.controls.filter((x) => x !== c) })}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={input}
            aria-label={`Action to learn for ${label}`}
            value={action}
            onChange={(e) => setAction(e.target.value as MidiControlAction)}
          >
            {CONTROL_ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant={learning ? "default" : "outline"}
            disabled={!device.connected}
            onClick={() => onLearn(learning ? null : action)}
          >
            <RadioIcon data-icon="inline-start" />
            {learning ? "Move a knob or press a button…" : "Learn"}
          </Button>
        </div>
      </div>
    </section>
  );
}
