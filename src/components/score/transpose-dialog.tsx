import { useId, useState, type FormEvent } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MAX_TRANSPOSE, type TransposeRequest, type TransposeScope } from "@/lib/score/transpose";

/** What moving the music would do, for the preview line. */
export interface TransposePreview {
  /** Notes that would move. */
  moved: number;
  /** Notes that would not fit on the instrument. */
  unplayable: number;
}

const SCOPES: { value: TransposeScope; label: string }[] = [
  { value: "selection", label: "Selection (or the note at the cursor)" },
  { value: "track", label: "This track" },
  { value: "score", label: "Whole song" },
];

const isScope = (value: string): value is TransposeScope => SCOPES.some((s) => s.value === value);

function TransposeForm({
  hasSelection,
  preview,
  onSubmit,
  onCancel,
}: {
  hasSelection: boolean;
  preview: (request: TransposeRequest) => TransposePreview;
  onSubmit: (request: TransposeRequest) => void;
  onCancel: () => void;
}) {
  const ids = { amount: useId(), scope: useId(), keys: useId() };
  const [scope, setScope] = useState<TransposeScope>(hasSelection ? "selection" : "track");
  const [semitones, setSemitones] = useState(2);
  const [keySignatures, setKeySignatures] = useState(true);

  const valid =
    Number.isInteger(semitones) && semitones !== 0 && Math.abs(semitones) <= MAX_TRANSPOSE;
  const request: TransposeRequest = { scope, semitones, keySignatures };
  const result = valid ? preview(request) : null;
  const blocked = result !== null && (result.unplayable > 0 || result.moved === 0);
  const step = (by: number) =>
    setSemitones((n) => Math.max(-MAX_TRANSPOSE, Math.min(MAX_TRANSPOSE, (n || 0) + by)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !blocked) onSubmit(request);
  };

  let status = `Enter 1 to ${MAX_TRANSPOSE} semitones, up (+) or down (−).`;
  if (result) {
    if (result.unplayable > 0) {
      status = `${result.unplayable} ${result.unplayable === 1 ? "note does" : "notes do"} not fit on the instrument. Nothing would be changed.`;
    } else if (result.moved === 0) {
      status = "There are no notes to move.";
    } else {
      status = `${result.moved} ${result.moved === 1 ? "note" : "notes"} will move ${semitones > 0 ? "up" : "down"} ${Math.abs(semitones)} ${Math.abs(semitones) === 1 ? "semitone" : "semitones"}.`;
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Transpose</DialogTitle>
        <DialogDescription>
          Moves notes up or down by semitones. Tab notes keep their string when they can, and move
          to another string when the fret would run out.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.amount} className="text-sm font-medium">
          Semitones (negative moves down)
        </label>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="One semitone down"
            onClick={() => step(-1)}
          >
            <MinusIcon />
          </Button>
          <Input
            id={ids.amount}
            type="number"
            inputMode="numeric"
            min={-MAX_TRANSPOSE}
            max={MAX_TRANSPOSE}
            value={Number.isNaN(semitones) ? "" : semitones}
            onChange={(event) => setSemitones(event.target.valueAsNumber)}
            className="w-24 text-center"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="One semitone up"
            onClick={() => step(1)}
          >
            <PlusIcon />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.scope} className="text-sm font-medium">
          Transpose
        </label>
        <Select value={scope} onValueChange={(value) => isScope(value) && setScope(value)}>
          <SelectTrigger id={ids.scope} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {scope !== "selection" && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={ids.keys}
            checked={keySignatures}
            onCheckedChange={(checked) => setKeySignatures(checked === true)}
          />
          <label htmlFor={ids.keys} className="text-sm">
            Also move the key signatures
          </label>
        </div>
      )}

      <p
        role="status"
        className={blocked ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
      >
        {status}
      </p>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || blocked}>
          Transpose
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Transposes the selection, the shown track or the whole song by semitones. */
export function TransposeDialog({
  open,
  onOpenChange,
  hasSelection,
  preview,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasSelection: boolean;
  preview: (request: TransposeRequest) => TransposePreview;
  onSubmit: (request: TransposeRequest) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <TransposeForm
          hasSelection={hasSelection}
          preview={preview}
          onSubmit={(request) => {
            onSubmit(request);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
