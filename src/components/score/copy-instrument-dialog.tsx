import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getPreset, INSTRUMENT_PRESETS, type InstrumentPreset } from "@/lib/score/music";

/** Instruments a track can be copied to (drums cannot be converted). */
const TARGETS = INSTRUMENT_PRESETS.filter((preset) => preset.kind !== "drums");

function CopyForm({
  trackName,
  onSubmit,
  onCancel,
}: {
  trackName: string;
  onSubmit: (preset: InstrumentPreset) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [presetId, setPresetId] = useState("piano");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const preset = getPreset(presetId);
    if (preset) onSubmit(preset);
  };
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>Copy to instrument</DialogTitle>
        <DialogDescription>
          Makes a new track from “{trackName}” for another instrument. The notes keep their rhythm
          and are moved to the strings, frets or keys that sound the same, or an octave away when
          the instrument cannot reach them.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">
            Instrument
          </label>
          <Select value={presetId} onValueChange={setPresetId}>
            <SelectTrigger id={id} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TARGETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Copy track</Button>
      </DialogFooter>
    </form>
  );
}

/** Asks which instrument to copy a track to. */
export function CopyInstrumentDialog({
  open,
  onOpenChange,
  trackName,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackName: string;
  onSubmit: (preset: InstrumentPreset) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <CopyForm
          trackName={trackName}
          onSubmit={(preset) => {
            onSubmit(preset);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
