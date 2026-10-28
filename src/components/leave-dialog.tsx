import { useRef } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * Asks what to do with unsaved songs before the start screen opens. The tabs always stay open, so
 * "Not now" loses nothing. Plain buttons (not AlertDialogAction) so only the chosen handler runs and
 * the `open` prop stays the single source of truth.
 */
export function LeaveDialog({
  songNames,
  open,
  onSave,
  onKeep,
  onCancel,
}: {
  /** The songs with unsaved changes. */
  songNames: string[];
  open: boolean;
  onSave: () => void;
  onKeep: () => void;
  onCancel: () => void;
}) {
  const saveRef = useRef<HTMLButtonElement>(null);
  const many = songNames.length > 1;
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          saveRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Save your changes?</AlertDialogTitle>
          <AlertDialogDescription>
            {many
              ? `These songs have unsaved changes: ${songNames.map((name) => `“${name}”`).join(", ")}.`
              : `“${songNames[0] ?? ""}” has unsaved changes.`}{" "}
            Save them now, or go to the start screen and keep them open to save later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={onKeep}>
            Not now
          </Button>
          <Button ref={saveRef} onClick={onSave}>
            {many ? "Save all" : "Save"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
