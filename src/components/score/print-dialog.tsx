import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
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
import {
  MARGINS,
  PAPERS,
  PRINT_SCALES,
  type Orientation,
  type Paper,
  type PrintSettings,
  type PrintTracks,
} from "@/lib/print";

type TrackChoice = "shown" | "all" | "some";

function PrintForm({
  initial,
  trackNames,
  shownTrack,
  onSubmit,
  onCancel,
}: {
  initial: PrintSettings;
  trackNames: string[];
  shownTrack: number;
  onSubmit: (settings: PrintSettings, tracks: PrintTracks) => void;
  onCancel: () => void;
}) {
  const ids = {
    paper: useId(),
    orientation: useId(),
    margin: useId(),
    scale: useId(),
    tracks: useId(),
  };
  const [settings, setSettings] = useState(initial);
  const [choice, setChoice] = useState<TrackChoice>("shown");
  const [chosen, setChosen] = useState<Set<number>>(() => new Set([shownTrack]));
  const tracks: PrintTracks =
    choice === "shown"
      ? [shownTrack]
      : choice === "all"
        ? trackNames.map((_, i) => i)
        : [...chosen].sort((a, b) => a - b);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (tracks.length > 0) onSubmit(settings, tracks);
  };
  const shownName = trackNames[shownTrack] ?? "the shown track";

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Print or save as PDF</DialogTitle>
        <DialogDescription>
          Prints the score in the page layout. To get a PDF, choose “Save as PDF” in the print
          dialog that opens next.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="flex flex-col gap-1.5 text-sm" aria-describedby={ids.tracks}>
        <legend className="mb-1 font-medium">Tracks</legend>
        {(
          [
            ["shown", `Only “${shownName}”`],
            ["all", `All ${trackNames.length} tracks, as a full score`],
            ["some", "Choose tracks…"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name={ids.tracks}
              value={value}
              checked={choice === value}
              onChange={() => setChoice(value)}
              className="accent-primary"
            />
            {label}
          </label>
        ))}
        {choice === "some" && (
          <div className="ml-6 flex flex-col gap-1">
            {trackNames.map((name, i) => {
              const id = `${ids.tracks}-${i}`;
              return (
                <div key={i} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={chosen.has(i)}
                    onCheckedChange={(on) =>
                      setChosen((set) => {
                        const next = new Set(set);
                        if (on === true) next.add(i);
                        else next.delete(i);
                        return next;
                      })
                    }
                  />
                  <label htmlFor={id}>{name}</label>
                </div>
              );
            })}
          </div>
        )}
        <p id={ids.tracks} className="text-xs text-muted-foreground">
          {tracks.length === 0
            ? "Choose at least one track."
            : "Several tracks are printed together, system by system, like a conductor's score."}
        </p>
      </fieldset>

      <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 text-sm">
        <span id={ids.scale}>Notation size</span>
        <Select
          value={String(settings.scale)}
          onValueChange={(scale) => setSettings((s) => ({ ...s, scale: Number(scale) }))}
        >
          <SelectTrigger aria-labelledby={ids.scale} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRINT_SCALES.map((scale) => (
              <SelectItem key={scale} value={String(scale)}>
                {Math.round(scale * 100)}%
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span id={ids.paper}>Paper size</span>
        <Select
          value={settings.paper}
          onValueChange={(paper) => setSettings((s) => ({ ...s, paper: paper as Paper }))}
        >
          <SelectTrigger aria-labelledby={ids.paper} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAPERS.map((paper) => (
              <SelectItem key={paper.value} value={paper.value}>
                {paper.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span id={ids.orientation}>Orientation</span>
        <Select
          value={settings.orientation}
          onValueChange={(orientation) =>
            setSettings((s) => ({ ...s, orientation: orientation as Orientation }))
          }
        >
          <SelectTrigger aria-labelledby={ids.orientation} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="portrait">Portrait</SelectItem>
            <SelectItem value="landscape">Landscape</SelectItem>
          </SelectContent>
        </Select>

        <span id={ids.margin}>Margins</span>
        <Select
          value={String(settings.margin)}
          onValueChange={(margin) => setSettings((s) => ({ ...s, margin: Number(margin) }))}
        >
          <SelectTrigger aria-labelledby={ids.margin} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MARGINS.map((margin) => (
              <SelectItem key={margin} value={String(margin)}>
                {margin} mm
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={tracks.length === 0}>
          Print…
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Page settings before the system print dialog (which also saves a PDF). */
export function PrintDialog({
  open,
  onOpenChange,
  initial,
  trackNames,
  shownTrack,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: PrintSettings;
  /** Every track of the song, by index. */
  trackNames: string[];
  /** The shown track: printed unless others are chosen. */
  shownTrack: number;
  onSubmit: (settings: PrintSettings, tracks: PrintTracks) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        {open && (
          <PrintForm
            initial={initial}
            trackNames={trackNames}
            shownTrack={shownTrack}
            onSubmit={(settings, tracks) => {
              onSubmit(settings, tracks);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
