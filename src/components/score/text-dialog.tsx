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
import { Input } from "@/components/ui/input";

export const MAX_TEXT_LENGTH = 100;

function TextForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string | null;
  onSubmit: (text: string | null) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(initial ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(text.trim() || null);
  };
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>Text</DialogTitle>
        <DialogDescription>Shown above the beat at the edit cursor.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">
            Text
          </label>
          <Input
            id={id}
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            placeholder="e.g. let ring, solo, fade out"
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        {initial && (
          <Button
            type="button"
            variant="outline"
            className="sm:mr-auto"
            onClick={() => onSubmit(null)}
          >
            Remove text
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Apply</Button>
      </DialogFooter>
    </form>
  );
}

/** Free text above the beat at the edit cursor. */
export function TextDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string | null;
  /** The new text, or null to remove it. */
  onSubmit: (text: string | null) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" onCloseAutoFocus={onCloseAutoFocus}>
        <TextForm
          initial={initial}
          onSubmit={(text) => {
            onSubmit(text);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
