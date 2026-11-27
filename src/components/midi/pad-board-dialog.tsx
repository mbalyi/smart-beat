import { FileAudioIcon, RadioIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { LabeledSlider } from "@/components/labeled-slider";
import { ActivityLight } from "@/components/midi/midi-armed-bar";
import { ChoiceGroup, MidiCard, MidiDialog } from "@/components/midi/midi-dialog";
import { deviceLabel, useMidiDevices } from "@/components/midi/use-midi-devices";
import { Button } from "@/components/ui/button";
import { newPad } from "@/lib/audio-lanes/midi";
import { padCells, padsToRoutes, type PadCell } from "@/lib/midi/pad-board";
import { DRUM_MIDI_MAP, MAIN_KIT } from "@/lib/score/drum-map";
import { errorText } from "@/lib/errors";
import {
  loadAudioSource,
  midiPadPreset,
  pickAudioFile,
  updateMidiDevice,
  type AudioLane,
  type AudioSource,
  type MidiDeviceSettings,
  type PadPlayback,
  type PadPreset,
  type PadSlot,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

const BANKS = ["A", "B", "C", "D"] as const;
const DRUMS = [
  ...MAIN_KIT,
  ...Object.keys(DRUM_MIDI_MAP)
    .map(Number)
    .filter((k) => !MAIN_KIT.includes(k)),
];

/**
 * The pad board (ADR 0006): your pad controller's pads as a grid that mirrors it (pad 1 bottom
 * left), each lit when you hit it. For each pad, learn which note it sends, then pick what it
 * plays: a drum of the kit, or (on a pad bank lane) a sample of your own with its playback,
 * tune, level, pan, choke group and effect sends. The pad map is saved with the device; the
 * samples are saved with the song.
 */
export function PadBoardDialog({
  open,
  onOpenChange,
  lane,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The MIDI lane the pads play (its pad bank or drums); null: only the device's pad map. */
  lane: AudioLane | null;
  /** Saves the lane's pads and the sources their samples came from (one Undo step). */
  onSave: (pads: PadSlot[], sources: AudioSource[]) => void;
}) {
  const { devices, activity } = useMidiDevices(open);
  const connected = devices.filter((d) => d.connected);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const device = devices.find((d) => d.name === deviceName) ?? connected[0] ?? null;
  const [edit, setEdit] = useState<{ device: MidiDeviceSettings | null; pads: PadSlot[] } | null>(
    null,
  );
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [bank, setBank] = useState(0);
  const [first, setFirst] = useState(36);
  const [selected, setSelected] = useState(0);
  const [learning, setLearning] = useState(false);
  const [seen, setSeen] = useState<number | null>(null);

  const padLane = lane?.instrument?.type === "pads";
  const settings = edit?.device ?? device?.settings ?? null;
  const pads = edit?.pads ?? (lane?.instrument?.type === "pads" ? lane.instrument.pads : []);
  const count = settings?.padLayout === "grid8" ? 8 : 16;
  const cells = padCells({ settings, pads, count, bank, first, padLane });
  const cell = cells[selected] ?? cells[0]!;

  // A hit while learning: the selected pad is the one that sends this note.
  if (activity && activity.at !== seen) {
    setSeen(activity.at);
    if (learning && activity.kind === "note" && (!device || activity.device === device.name)) {
      setLearning(false);
      update({ device: settings && { ...settings, pads: route(settings, cell, activity.number) } });
    }
  }

  function update(next: Partial<{ device: MidiDeviceSettings | null; pads: PadSlot[] }>) {
    setEdit({ device: settings, pads, ...next });
  }
  function route(s: MidiDeviceSettings, c: PadCell, sends: number) {
    return [
      ...s.pads.filter((r) => r.from !== c.sends && r.from !== sends),
      { from: sends, to: c.plays },
    ];
  }
  const setPad = (patch: Partial<PadSlot>) => {
    const existing = pads.find((p) => p.key === cell.plays);
    const slot = { ...(existing ?? newPad(cell.plays, `Pad ${cell.index + 1}`)), ...patch };
    update({ pads: [...pads.filter((p) => p.key !== cell.plays), slot] });
  };
  const setPlays = (to: number) => {
    if (!settings) return;
    update({
      device: {
        ...settings,
        pads: [...settings.pads.filter((r) => r.from !== cell.sends), { from: cell.sends, to }],
      },
    });
  };
  const applyPreset = async (preset: PadPreset) => {
    if (!settings) return;
    try {
      const routes = await midiPadPreset(preset, first + bank * count, count);
      const sent = new Set(routes.map((r) => r.from));
      update({
        device: {
          ...settings,
          pads: [...settings.pads.filter((r) => !sent.has(r.from)), ...routes],
        },
      });
    } catch (error) {
      toast.error("Couldn't load the preset", { description: errorText(error) });
    }
  };
  const chooseSample = async () => {
    try {
      const path = await pickAudioFile();
      if (!path) return;
      const info = await loadAudioSource({ type: "file", path });
      const name = path.split(/[\\/]/).pop() ?? "sample";
      setSources((s) => [
        ...s.filter((x) => x.id !== info.id),
        { id: info.id, name, ext: info.ext, path, embedded: true },
      ]);
      setPad({ sourceId: info.id, name: name.replace(/\.[^.]+$/, ""), drum: undefined });
    } catch (error) {
      toast.error("Couldn't open the sample", { description: errorText(error) });
    }
  };

  const slot = pads.find((p) => p.key === cell.plays);
  const rows = count === 16 ? 4 : 2;
  // Pad 1 is bottom left: the grid is drawn top row first.
  const order = Array.from({ length: rows }, (_, r) => rows - 1 - r).flatMap((r) =>
    Array.from({ length: 4 }, (_, c) => r * 4 + c),
  );

  return (
    <MidiDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setEdit(null);
          setSources([]);
          setLearning(false);
        }
        onOpenChange(next);
      }}
      title="Pad board"
      description="Hit a pad to see it light up. Pick a pad here, then choose what it plays. Note repeat, velocity curves and pad modes are set on the controller itself."
      action="Save"
      testId="pad-board-dialog"
      onAction={() => {
        // On a pad bank lane every pad of the bank is routed to its pad, so a hit plays it.
        const device =
          settings && padLane
            ? { ...settings, pads: padsToRoutes(settings.pads, cells) }
            : edit?.device;
        if (device)
          void updateMidiDevice(device).catch((e: unknown) =>
            toast.error("Couldn't save the pad map", { description: errorText(e) }),
          );
        if (lane && edit) onSave(edit.pads, sources);
        setEdit(null);
        onOpenChange(false);
      }}
    >
      <MidiCard title="Your pad controller">
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No MIDI device is connected. Plug in your pad controller (Bluetooth MIDI is paired in
            the Mac's Audio MIDI Setup first); it shows up here within a few seconds.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Pad controller"
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={device?.name ?? ""}
              onChange={(e) => {
                setDeviceName(e.target.value);
                setEdit(null);
              }}
            >
              {devices.map((d) => (
                <option key={d.name} value={d.name}>
                  {deviceLabel(d)}
                  {d.connected ? "" : " (not connected)"}
                </option>
              ))}
            </select>
            <ChoiceGroup
              label="Pads"
              value={count === 16 ? "grid16" : "grid8"}
              options={[
                { value: "grid16", label: "16 pads" },
                { value: "grid8", label: "8 pads" },
              ]}
              onChange={(padLayout) => settings && update({ device: { ...settings, padLayout } })}
            />
            <ChoiceGroup
              label="Bank"
              value={String(bank)}
              options={BANKS.map((b, i) => ({ value: String(i), label: `Bank ${b}` }))}
              onChange={(b) => setBank(Number(b))}
            />
            <label className="flex items-center gap-1.5 text-sm">
              First note
              <input
                type="number"
                aria-label="Note the first pad sends"
                className="h-9 w-16 rounded-md border bg-card px-2 text-sm"
                min={0}
                max={127}
                value={first}
                onChange={(e) => setFirst(Math.min(127, Math.max(0, Number(e.target.value) || 0)))}
              />
            </label>
          </div>
        )}
        {settings && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void applyPreset("gmKit")}>
              Drum kit layout
            </Button>
            <Button size="sm" variant="outline" onClick={() => void applyPreset("chromatic")}>
              One pad per note
            </Button>
            <Button size="sm" variant="outline" onClick={() => void applyPreset("thru")}>
              As the controller sends
            </Button>
          </div>
        )}
      </MidiCard>

      <div role="group" aria-label="Pads" data-testid="pad-grid" className="grid grid-cols-4 gap-2">
        {order.map((i) => {
          const c = cells[i];
          if (!c) return null;
          const hit =
            activity?.kind === "note" &&
            activity.number === c.sends &&
            (!device || activity.device === device.name);
          return (
            <button
              key={i}
              type="button"
              aria-pressed={selected === i}
              aria-label={`Pad ${i + 1}: sends note ${c.sends}, plays ${c.label}`}
              onClick={() => setSelected(i)}
              className={cn(
                "relative flex h-20 flex-col items-start justify-between rounded-xl border-2 bg-card p-2 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected === i ? "border-primary" : "border-border hover:bg-accent",
              )}
            >
              <span className="flex w-full items-center justify-between text-xs text-muted-foreground">
                Pad {i + 1}
                {hit && <ActivityLight at={activity.at} />}
              </span>
              <span className="w-full truncate text-sm font-semibold">{c.label}</span>
              <span className="text-[10px] text-muted-foreground">note {c.sends}</span>
            </button>
          );
        })}
      </div>

      <MidiCard title={`Pad ${cell.index + 1}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={learning ? "default" : "outline"}
            disabled={!settings}
            onClick={() => setLearning((l) => !l)}
          >
            <RadioIcon data-icon="inline-start" />
            {learning ? "Hit the pad on your controller…" : "Learn: hit the pad"}
          </Button>
          <span className="text-sm text-muted-foreground">It sends note {cell.sends}.</span>
        </div>
        {padLane ? (
          <PadSound
            slot={slot}
            onChange={setPad}
            onChooseSample={() => void chooseSample()}
            onClear={() => update({ pads: pads.filter((p) => p.key !== cell.plays) })}
          />
        ) : (
          <label className="flex items-center gap-2 text-sm">
            Plays
            <select
              aria-label={`Drum pad ${cell.index + 1} plays`}
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={cell.plays}
              disabled={!settings}
              onChange={(e) => setPlays(Number(e.target.value))}
            >
              {DRUMS.map((k) => (
                <option key={k} value={k}>
                  {DRUM_MIDI_MAP[k] ?? `Note ${k}`} ({k})
                </option>
              ))}
            </select>
          </label>
        )}
      </MidiCard>
    </MidiDialog>
  );
}

/** What a pad of a pad bank plays: a sample (with its settings) or a drum of the kit. */
function PadSound({
  slot,
  onChange,
  onChooseSample,
  onClear,
}: {
  slot: PadSlot | undefined;
  onChange: (patch: Partial<PadSlot>) => void;
  onChooseSample: () => void;
  onClear: () => void;
}) {
  const slider = (
    label: string,
    key: keyof PadSlot,
    value: number,
    min: number,
    max: number,
    step: number,
    text: string,
  ) => (
    <LabeledSlider
      label={label}
      valueText={text}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={!slot}
      onValueChange={(v) => onChange({ [key]: v } as Partial<PadSlot>)}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onChooseSample}>
          <FileAudioIcon data-icon="inline-start" />
          {slot?.sourceId ? "Change the sample…" : "Choose a sample…"}
        </Button>
        <select
          aria-label="Or a drum of the kit"
          className="h-8 rounded-md border bg-card px-2 text-sm"
          value={slot?.drum ?? ""}
          onChange={(e) =>
            e.target.value &&
            onChange({
              drum: Number(e.target.value),
              sourceId: undefined,
              name: DRUM_MIDI_MAP[Number(e.target.value)] ?? "Drum",
            })
          }
        >
          <option value="">Or a drum of the kit…</option>
          {DRUMS.map((k) => (
            <option key={k} value={k}>
              {DRUM_MIDI_MAP[k] ?? `Note ${k}`}
            </option>
          ))}
        </select>
        {slot && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            <Trash2Icon data-icon="inline-start" /> Clear
          </Button>
        )}
        {slot && <span className="truncate text-sm font-medium">{slot.name}</span>}
      </div>
      {slot && (
        <>
          <ChoiceGroup<PadPlayback>
            label="Playback"
            value={slot.playback}
            options={[
              { value: "oneShot", label: "One shot" },
              { value: "gate", label: "While held" },
              { value: "loop", label: "Loop while held" },
            ]}
            onChange={(playback) => onChange({ playback })}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {slider(
              "Volume",
              "volume",
              slot.volume,
              0,
              1,
              0.01,
              `${Math.round(slot.volume * 100)} %`,
            )}
            {slider(
              "Pan",
              "pan",
              slot.pan,
              -1,
              1,
              0.01,
              slot.pan === 0 ? "Centre" : `${Math.round(slot.pan * 100)}`,
            )}
            {slider(
              "Tune",
              "semitones",
              slot.semitones,
              -24,
              24,
              1,
              `${slot.semitones > 0 ? "+" : ""}${slot.semitones} st`,
            )}
            {slider(
              "Velocity",
              "velDepth",
              slot.velDepth,
              0,
              1,
              0.01,
              `${Math.round(slot.velDepth * 100)} %`,
            )}
            {slider(
              "Choke group",
              "choke",
              slot.choke,
              0,
              16,
              1,
              slot.choke === 0 ? "None" : String(slot.choke),
            )}
            {slider("Voices", "voices", slot.voices, 1, 32, 1, String(slot.voices))}
            {slider(
              "Reverb send (bus 1)",
              "sendA",
              slot.sendA,
              0,
              1,
              0.01,
              `${Math.round(slot.sendA * 100)} %`,
            )}
            {slider(
              "Delay send (bus 2)",
              "sendB",
              slot.sendB,
              0,
              1,
              0.01,
              `${Math.round(slot.sendB * 100)} %`,
            )}
          </div>
        </>
      )}
    </div>
  );
}
