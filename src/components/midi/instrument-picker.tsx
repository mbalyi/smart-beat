import { DrumIcon, Grid3x3Icon, PianoIcon, PlugIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GM_INSTRUMENTS } from "@/lib/score/music";
import { errorText } from "@/lib/errors";
import {
  listKits,
  scanPlugins,
  type DrumKit,
  type LaneInstrument,
  type ScannedPlugin,
} from "@/lib/tauri";
import { instrumentName } from "@/lib/midi-editor/instruments";
import { cn } from "@/lib/utils";

const FAMILIES = [
  "Piano",
  "Chromatic percussion",
  "Organ",
  "Guitar",
  "Bass",
  "Strings",
  "Ensemble",
  "Brass",
  "Reed",
  "Pipe",
  "Synth lead",
  "Synth pad",
  "Synth effects",
  "Ethnic",
  "Percussive",
  "Sound effects",
];

/**
 * What a MIDI lane sounds with (ADR 0006): a General MIDI sound, the drum kit, an imported kit, a
 * pad bank of your own samples, or a VST3/CLAP instrument. Kits are listed when it opens;
 * instrument plugins when asked (a scan takes a moment).
 */
export function InstrumentPicker({
  instrument,
  onChange,
  onEditPads,
  className,
}: {
  instrument: LaneInstrument | undefined;
  onChange: (instrument: LaneInstrument) => void;
  /** Opens the pad board (to map pads and pick samples). */
  onEditPads?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [kits, setKits] = useState<DrumKit[] | null>(null);
  const [plugins, setPlugins] = useState<ScannedPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const program = instrument?.type === "soundfont" ? instrument.program : 0;
  const choose = (next: LaneInstrument) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && kits === null)
          listKits()
            .then(setKits)
            .catch(() => setKits([]));
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-7 max-w-44 gap-1 px-2 text-xs", className)}
          data-tour="midi-instrument"
          aria-label={`Instrument: ${instrumentName(instrument)}`}
        >
          {instrument?.type === "drums" || instrument?.type === "kit" ? (
            <DrumIcon />
          ) : instrument?.type === "pads" ? (
            <Grid3x3Icon />
          ) : instrument?.type === "plugin" ? (
            <PlugIcon />
          ) : (
            <PianoIcon />
          )}
          <span className="truncate">{instrumentName(instrument)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-3" align="start">
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold">General MIDI sound</h3>
          <select
            aria-label="General MIDI sound"
            className="h-9 rounded-md border bg-card px-2 text-sm"
            value={instrument?.type === "soundfont" || !instrument ? program : ""}
            onChange={(e) =>
              choose({ type: "soundfont", program: Number(e.target.value), bank: 0 })
            }
          >
            {instrument && instrument.type !== "soundfont" && (
              <option value="">Choose a sound…</option>
            )}
            {FAMILIES.map((family, f) => (
              <optgroup key={family} label={family}>
                {GM_INSTRUMENTS.slice(f * 8, f * 8 + 8).map((name, i) => (
                  <option key={name} value={f * 8 + i}>
                    {name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold">Drums</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={instrument?.type === "drums" ? "default" : "outline"}
              onClick={() => choose({ type: "drums" })}
            >
              <DrumIcon /> Drum kit
            </Button>
            <Button
              size="sm"
              variant={instrument?.type === "pads" ? "default" : "outline"}
              onClick={() => {
                if (instrument?.type !== "pads") choose({ type: "pads", pads: [] });
                setOpen(false);
                onEditPads?.();
              }}
            >
              <Grid3x3Icon /> Pad bank…
            </Button>
          </div>
          {kits && kits.length > 0 && (
            <select
              aria-label="Imported kit"
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={instrument?.type === "kit" ? instrument.kitId : ""}
              onChange={(e) => e.target.value && choose({ type: "kit", kitId: e.target.value })}
            >
              <option value="">An imported kit…</option>
              {kits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          )}
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold">Instrument plugin</h3>
          {plugins === null ? (
            <Button
              size="sm"
              variant="outline"
              disabled={scanning}
              onClick={() => {
                setScanning(true);
                setError(null);
                scanPlugins()
                  .then((r) => setPlugins(r.plugins.filter((p) => p.instrument)))
                  .catch((e: unknown) => setError(errorText(e)))
                  .finally(() => setScanning(false));
              }}
            >
              <SearchIcon /> {scanning ? "Looking for plugins…" : "Find VST3 and CLAP instruments"}
            </Button>
          ) : plugins.length === 0 ? (
            <p className="text-xs text-muted-foreground">No instrument plugins are installed.</p>
          ) : (
            <select
              aria-label="Instrument plugin"
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={instrument?.type === "plugin" ? instrument.path : ""}
              onChange={(e) => {
                const p = plugins.find((x) => x.path === e.target.value);
                if (p) choose({ type: "plugin", format: p.format, path: p.path, name: p.name });
              }}
            >
              <option value="">Choose a plugin…</option>
              {plugins.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name} ({p.format.toUpperCase()})
                </option>
              ))}
            </select>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </section>
      </PopoverContent>
    </Popover>
  );
}
