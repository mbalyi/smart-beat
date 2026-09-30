import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
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
import { MARGINS, PAPERS, type Orientation, type Paper, type PrintSettings } from "@/lib/print";

function PrintForm({
  initial,
  trackName,
  onSubmit,
  onCancel,
}: {
  initial: PrintSettings;
  trackName: string;
  onSubmit: (settings: PrintSettings) => void;
  onCancel: () => void;
}) {
  const ids = { paper: useId(), orientation: useId(), margin: useId() };
  const [settings, setSettings] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(settings);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Print or save as PDF</DialogTitle>
        <DialogDescription>
          Prints the score of “{trackName}” in the page layout. To get a PDF, choose “Save as PDF”
          in the print dialog that opens next.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 text-sm">
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
        <Button type="submit">Print…</Button>
      </DialogFooter>
    </form>
  );
}

/** Page settings before the system print dialog (which also saves a PDF). */
export function PrintDialog({
  open,
  onOpenChange,
  initial,
  trackName,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: PrintSettings;
  /** The shown track: the one that is printed. */
  trackName: string;
  onSubmit: (settings: PrintSettings) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        {open && (
          <PrintForm
            initial={initial}
            trackName={trackName}
            onSubmit={(settings) => {
              onSubmit(settings);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
