import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Asks before the start screen replaces open songs that have unsaved changes. */
export function LeaveDialog({
  songNames,
  open,
  onCancel,
  onLeave,
}: {
  /** The songs with unsaved changes. */
  songNames: string[];
  open: boolean;
  onCancel: () => void;
  onLeave: () => void;
}) {
  const many = songNames.length > 1;
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            {many
              ? `These songs have unsaved changes: ${songNames.map((name) => `“${name}”`).join(", ")}. `
              : `“${songNames[0] ?? ""}” has unsaved changes. `}
            Going to the start screen closes {many ? "them" : "it"} and the changes are lost. Choose
            Stay here, then Save (File menu), to keep your changes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay here</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onLeave}>
            Leave without saving
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
