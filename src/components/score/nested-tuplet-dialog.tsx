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
import { composeTuplet, isTuplet, TUPLETS, tupletKey, type Tuplet } from "@/lib/score/music";

/** The tuplets that can be nested (every one but "None"). */
const CHOICES = TUPLETS.filter((t) => t.numerator > 1);

const find = (key: string) => CHOICES.find((t) => tupletKey(t) === key) ?? CHOICES[0]!;

function RatioSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Tuplet;
  onChange: (tuplet: Tuplet) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <Select value={tupletKey(value)} onValueChange={(key) => onChange(find(key))}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CHOICES.map((t) => (
            <SelectItem key={tupletKey(t)} value={tupletKey(t)}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * A tuplet inside a tuplet (a triplet of triplets, a quintuplet inside a
 * triplet…): pick the outer and the inner ratio, and the notes get the one
 * ratio they add up to. The score draws one bracket; playback follows the
 * ratio.
 */
export function NestedTupletDialog({
  open,
  onOpenChange,
  onApply,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (tuplet: Tuplet) => void;
  /** Where the focus goes when the dialog closes (the score, so typing continues). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [outer, setOuter] = useState<Tuplet>(find("3:2"));
  const [inner, setInner] = useState<Tuplet>(find("3:2"));
  const result = composeTuplet(outer, inner);
  const valid = isTuplet(result);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onApply({ numerator: result.numerator, denominator: result.denominator });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Nested tuplet</DialogTitle>
            <DialogDescription>
              A tuplet inside a tuplet. The selected notes are played as one group.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <RatioSelect label="Outer tuplet" value={outer} onChange={setOuter} />
            <RatioSelect
              label="Inner tuplet (inside each note of the outer one)"
              value={inner}
              onChange={setInner}
            />
            <p role="status" data-testid="nested-tuplet-result" className="text-sm">
              {valid ? (
                <>
                  Result:{" "}
                  <strong>
                    {result.numerator} notes in the time of {result.denominator}
                  </strong>{" "}
                  ({tupletKey(result)}). The score shows one bracket for the whole group.
                </>
              ) : (
                "This combination has too many notes."
              )}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
